# Use a Node.js base image
FROM node:lts-slim

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the application code
COPY app.js .

# Expose the port the app runs on (3005)
EXPOSE 3005

# Command to run the application
CMD [ "node", "index.js" ]