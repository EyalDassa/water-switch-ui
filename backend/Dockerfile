FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist/server.js ./server.js
EXPOSE 3001
CMD ["node", "--dns-result-order=ipv4first", "server.js"]
