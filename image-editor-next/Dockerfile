FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
ENV OCR_SERVICE_URL=http://ocr:8001
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV OCR_SERVICE_URL=http://ocr:8001
COPY --from=build /app .
EXPOSE 3000
CMD ["npm", "run", "start"]
