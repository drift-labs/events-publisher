FROM public.ecr.aws/bitnami/node:18
RUN apt-get install git
ENV NODE_ENV=production
RUN npm install -g yarn
RUN npm install -g typescript

WORKDIR /app
COPY . .
WORKDIR /app/drift-common/protocol/sdk
RUN yarn
RUN yarn build
WORKDIR /app/drift-common/common-ts
RUN yarn
RUN yarn build
WORKDIR /app
RUN yarn --production=false
RUN yarn test
RUN yarn build

EXPOSE 9464

CMD [ "yarn", "start" ]