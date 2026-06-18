FROM nikolaik/python-nodejs:python3.11-nodejs20
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN pip install yt-dlp
CMD ["node", "index.js"]