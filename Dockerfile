FROM node:18 AS builder

WORKDIR /app

# Install build dependencies
RUN apt update -y && apt install git build-essential make python3 -y
# Copy package files first to leverage cache
COPY package.json yarn.lock ./
COPY drift-common/protocol/sdk/package.json ./drift-common/protocol/sdk/
COPY drift-common/common-ts/package.json ./drift-common/common-ts/

ENV NODE_ENV=production

WORKDIR /app/drift-common/protocol/sdk
COPY drift-common/protocol/sdk/ .
RUN yarn && yarn build

WORKDIR /app/drift-common/common-ts
COPY drift-common/common-ts/ .
RUN yarn && yarn build

WORKDIR /app
COPY . .
RUN yarn && yarn build

FROM node:18-alpine
COPY --from=builder /app/dist/ ./lib/

ENV NODE_ENV=production
EXPOSE 9464

CMD ["node", "./lib/index.js"]