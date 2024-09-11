import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { EventType } from '@drift-labs/sdk';

export class WsClient extends EventEmitter {
	private ws: WebSocket;
	private reconnectInterval: number = 5000; // 5 seconds
	private heartbeatInterval: NodeJS.Timeout | null = null;
	private url: string;

	constructor(url: string) {
		super();
		this.url = url;
		this.ws = this.connect();
	}

	private connect(): WebSocket {
		const ws = new WebSocket(this.url);

		ws.on('open', () => {
			console.log('Connected to WebSocket server');
			this.emit('connected');
			this.startHeartbeat();
		});

		ws.on('message', (data: WebSocket.Data) => {
			try {
				const parsedData = JSON.parse(data.toString());
				if (parsedData.channel === 'heartbeat') {
					// Handle heartbeat
					return;
				}
				this.emit('message', parsedData);
			} catch (error) {
				console.error('Error parsing message:', error);
			}
		});

		ws.on('close', () => {
			console.log('Disconnected from WebSocket server');
			this.stopHeartbeat();
			this.emit('disconnected');
			setTimeout(() => this.reconnect(), this.reconnectInterval);
		});

		ws.on('error', (error) => {
			console.error('WebSocket error:', error);
			this.emit('error', error);
		});

		return ws;
	}

	private reconnect(): void {
		console.log('Attempting to reconnect...');
		this.ws = this.connect();
	}

	private startHeartbeat(): void {
		this.heartbeatInterval = setInterval(() => {
			if (this.ws.readyState === WebSocket.OPEN) {
				this.ws.ping();
			}
		}, 30000); // Send ping every 30 seconds
	}

	private stopHeartbeat(): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
	}

	public subscribe(channel: EventType, user?: string): void {
		const message = {
			type: 'subscribe',
			channel: channel,
			user: user
		};
		this.ws.send(JSON.stringify(message));
	}

	public unsubscribe(channel: EventType, user?: string): void {
		const message = {
			type: 'unsubscribe',
			channel: channel,
			user: user
		};
		this.ws.send(JSON.stringify(message));
	}

	public close(): void {
		this.ws.close();
		this.stopHeartbeat();
	}
}

const client = new WsClient('wss://events.drift.trade/ws');
const main = async () => {
	client.on('connected', () => {
		client.subscribe('OrderRecord', 'H5jfagEnMVNH3PMc2TU2F7tNuXE6b4zCwoL5ip1b4ZHi');
		client.subscribe('OrderActionRecord', 'H5jfagEnMVNH3PMc2TU2F7tNuXE6b4zCwoL5ip1b4ZHi');
	});
	client.on('message', (data) => {
		console.log('Received:', data);
	});
}

main().catch(console.error);