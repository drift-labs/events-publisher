FROM node:18-alpine AS builder
RUN apk add git
RUN npm install -g typescript @vercel/ncc

ENV NODE_ENV=production
WORKDIR /app
COPY . .
WORKDIR /app/drift-common/protocol/sdk
RUN yarn
RUN yarn build
WORKDIR /app/drift-common/common-ts
RUN yarn
RUN yarn build
WORKDIR /app
RUN yarn
RUN yarn build
RUN ncc build lib/index.js -o dist

FROM  node:18-alpine
WORKDIR /app
COPY --from=builder /app/dist/ dist/
ENV NODE_ENV=production
EXPOSE 9464

CMD ["node", "./dist/index.js"]