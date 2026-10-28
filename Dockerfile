FROM node:20-alpine

ARG GIT_COMMIT=unknown
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 8080

CMD ["node", "backend/server.js"]
