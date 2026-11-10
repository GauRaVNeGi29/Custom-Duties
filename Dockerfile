FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Generate the database client and build once, at image build time,
# so Cloud Run cold starts only apply pending migrations and start the server.
RUN npx prisma generate && npm run build

CMD ["npm", "run", "docker-start"]
