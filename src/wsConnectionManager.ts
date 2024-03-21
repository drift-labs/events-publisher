import cors from "cors";
import express from "express";
import * as http from "http";
import compression from "compression";
import { WebSocket, WebSocketServer } from "ws";
import { register, Gauge } from "prom-client";
import { DriftEnv, PerpMarkets, SpotMarkets } from "@drift-labs/sdk";
import { createRedisClient, getEventTypeFromChannel } from "./utils/utils";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

// Set up env constants
require("dotenv").config();
const driftEnv = (process.env.ENV || "devnet") as DriftEnv;

const app = express();
app.use(cors({ origin: "*" }));
app.use(compression());
app.set("trust proxy", 1);

const wsConnectionsGauge = new Gauge({
  name: "websocket_connections",
  help: "Number of active WebSocket connections",
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  perMessageDeflate: true,
});

const WS_PORT = process.env.WS_PORT || "3000";
const RUNNING_LOCAL = process.env.RUNNING_LOCAL === "true";
const MAX_BUFFERED_AMOUNT = 300000;

console.log(`WS LISTENER PORT : ${WS_PORT}`);

const safeGetRawChannelFromMessage = (message: any): string => {
  return message?.channel;
};

const getRedisChannelFromMessage = (message: any): string => {
  const channel = message.channel;
  const eventType = getEventTypeFromChannel(channel);
  if (!eventType) {
    throw new Error("Bad channel specified");
  }
  return eventType as string;
};

async function main() {
  // Subscribe to redis
  const ssmClient = new SSMClient({
    region: process.env.ENV === "devnet" ? "us-east-1" : "eu-west-1",
  });
  const input = {
    Name: `/${process.env.BRANCH_NAME}/eventsElasticache`,
  };
  const command = new GetParameterCommand(input);
  const response = await ssmClient.send(command);
  const uri = response.Parameter?.Value;
  if (!uri) {
    throw new Error("Missing Elasticache URIs in parameter store");
  }
  const redisClient = createRedisClient(
    RUNNING_LOCAL ? "localhost" : (uri as string),
    RUNNING_LOCAL ? 6377 : 6379,
    !RUNNING_LOCAL,
  );
  await redisClient.connect();

  const channelSubscribers = new Map<string, Set<WebSocket>>();
  const subscribedChannels = new Set<string>();

  redisClient.on("connect", () => {
    subscribedChannels.forEach(async (channel) => {
      try {
        await redisClient.subscribe(channel);
      } catch (error) {
        console.error(`Error subscribing to ${channel}:`, error);
      }
    });
  });

  redisClient.on("message", (subscribedChannel, message) => {
    const subscribers = channelSubscribers.get(subscribedChannel);
    if (subscribers) {
      subscribers.forEach((ws) => {
        if (
          ws.readyState === WebSocket.OPEN &&
          ws.bufferedAmount < MAX_BUFFERED_AMOUNT
        )
          ws.send(
            JSON.stringify({ channel: subscribedChannel, data: message }),
          );
      });
    }
  });

  redisClient.on("error", (error) => {
    console.error("Redis client error:", error);
  });

  wss.on("connection", (ws: WebSocket) => {
    console.log("Client connected");
    wsConnectionsGauge.inc();

    ws.on("message", async (msg) => {
      let parsedMessage: any;
      let messageType: string;
      try {
        parsedMessage = JSON.parse(msg.toString());
        messageType = parsedMessage.type.toLowerCase();
      } catch (e) {
        return;
      }

      switch (messageType) {
        case "subscribe": {
          let redisChannel: string;
          try {
            redisChannel = getRedisChannelFromMessage(parsedMessage);
            console.log(redisChannel);
          } catch (error) {
            const requestChannel = safeGetRawChannelFromMessage(parsedMessage);
            if (requestChannel) {
              ws.send(
                JSON.stringify({
                  channel: requestChannel,
                  error:
                    "Error subscribing to channel with data: " +
                    JSON.stringify(parsedMessage),
                }),
              );
            } else {
              ws.close(
                1003,
                JSON.stringify({
                  error:
                    "Error subscribing to channel with data: " +
                    JSON.stringify(parsedMessage),
                }),
              );
            }
            return;
          }

          if (!subscribedChannels.has(redisChannel)) {
            console.log("Trying to subscribe to channel", redisChannel);
            redisClient
              .subscribe(redisChannel)
              .then(() => {
                subscribedChannels.add(redisChannel);
              })
              .catch(() => {
                ws.send(
                  JSON.stringify({
                    error: `Error subscribing to channel: ${parsedMessage}`,
                  }),
                );
                return;
              });
          }

          if (!channelSubscribers.get(redisChannel)) {
            const subscribers = new Set<WebSocket>();
            channelSubscribers.set(redisChannel, subscribers);
          }
          channelSubscribers.get(redisChannel)?.add(ws);

          ws.send(
            JSON.stringify({
              message: `Subscribe received for channel: ${parsedMessage.channel}, market: ${parsedMessage.market}, marketType: ${parsedMessage.marketType}`,
            }),
          );
          break;
        }
        case "unsubscribe": {
          let redisChannel: string;
          try {
            redisChannel = getRedisChannelFromMessage(parsedMessage);
          } catch (error: any) {
            const requestChannel = safeGetRawChannelFromMessage(parsedMessage);
            if (requestChannel) {
              console.log("Error unsubscribing from channel:", error.message);
              ws.send(
                JSON.stringify({
                  channel: requestChannel,
                  error:
                    "Error unsubscribing from channel with data: " +
                    JSON.stringify(parsedMessage),
                }),
              );
            } else {
              ws.close(
                1003,
                JSON.stringify({
                  error:
                    "Error unsubscribing from channel with data: " +
                    JSON.stringify(parsedMessage),
                }),
              );
            }
            return;
          }
          const subscribers = channelSubscribers.get(redisChannel);
          if (subscribers) {
            channelSubscribers.get(redisChannel)?.delete(ws);
          }
          break;
        }
        case undefined:
        default:
          break;
      }
    });

    // Set interval to send heartbeat every 5 seconds
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ channel: "heartbeat" }));
      } else {
        clearInterval(heartbeatInterval);
      }
    }, 5000);

    // Buffer overflow check interval
    const bufferInterval = setInterval(() => {
      if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1008, "Buffer overflow");
        }
        clearInterval(bufferInterval);
      }
    }, 10000);

    // Handle disconnection
    ws.on("close", () => {
      console.log("Client disconnected");
      // Clear any existing intervals
      clearInterval(heartbeatInterval);
      clearInterval(bufferInterval);
      channelSubscribers.forEach((subscribers, channel) => {
        if (subscribers.delete(ws) && subscribers.size === 0) {
          redisClient.unsubscribe(channel);
          channelSubscribers.delete(channel);
          subscribedChannels.delete(channel);
        }
      });
      wsConnectionsGauge.dec();
    });

    ws.on("error", (error) => {
      console.error("Socket error:", error);
    });
  });

  server.listen(WS_PORT, () => {
    console.log(`connection manager running on ${WS_PORT}`);
  });

  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });

  server.on("error", (error) => {
    console.error("Server error:", error);
  });
}

main();
