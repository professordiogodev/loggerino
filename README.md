<!-- LAB | Alloy for Logs -->

### Prerequisite: Create the Docker Network

First, let's create the dedicated bridge network that all your services will join.

```bash
docker network create monitoring
```

### Create a Volume

We’re going to need the same volume for both `loggerino` and `alloy`. This way, we can have all logs in the same shared “folder”, without having to jump into docker’s internal folder structure.

```python
docker volume create logs-volume
```

---

Clone the repository available in `https://github.com/professordiogodev/loggerino` and open it in VS Code.

```
git clone https://github.com/professordiogodev/loggerino.git
cd loggerino
code .
```

### Step 1: Run the Express Application

You'll need to build the Node.js application into a Docker image first.

### A. Create a `Dockerfile` (it already exists in the repo)

```docker
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
CMD [ "node", "app.js" ]
```

### B. Build the Image

Assuming your `index.js` and `package.json` are in the current directory (you can also push it):

```bash
docker build -t pokfinner/loggerino .
# docker push pokfinner/loggerino
```

### C. Run the Container

Run the Express app container, linking it to the `monitoring` network. We'll also mount the current directory so the `main.log` file is written to your host machine's filesystem.

```bash
docker run -d \
  --name loggerino \
  --network monitoring \
  -p 3005:3005 \
  -v logs-volume:/usr/src/app/logs \
  pokfinner/loggerino
```

- `-v logs-volume:/usr/src/app/logs`: This is crucial. It mounts a volume to the container's working directory. This makes the `main.log` file accessible also to the Alloy container, which we will also use the same volume.

### Step 2: Run Loki Server

Start the Loki server, placing it on the `monitoring` network. We'll use its hostname (`loki`) later for Alloy to connect.

Attention: For Loki’s new versions (compatible with alloy), you need a new `loki-config.yaml` file.

```python
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2020-10-24
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

```

Run Loki:

```bash
docker run -d \
  --name loki \
  --network monitoring \
  -p 3100:3100 \
  -v $(pwd)/loki-config.yaml:/etc/loki/local-config.yaml \
  grafana/loki:latest \
  -config.file=/etc/loki/local-config.yaml
```

### Step 3: Run Alloy Agent

The Alloy agent needs to read the log file created by the Express app and send it to the Loki server.

### A. Ensure `alloy-config.alloy` is ready

Use the same configuration file as before, but note the Loki URL is now just the service name (`loki`):

```
// Component 1: Finds the file targets on the filesystem
// We replace /var/log/*.log with the specific log file path

local.file_match "express_log_matcher" {
  // Use the specific file path from our Express app lab setup
  path_targets = [{__path__ = "/app/*.log"}]
  sync_period = "5s"
}

// Component 2: Reads the logs from the matched file targets
loki.source.file "log_scrape" {
  // Pulls the targets (i.e., "/app/main.log") from the matcher component
  targets = local.file_match.express_log_matcher.targets
  
  // Forward the scraped logs to the processor component
  forward_to = [loki.process.filter_logs.receiver] 
  
  tail_from_end = true
}

// Component 3: Processes the logs (e.g., drops unwanted lines)
loki.process "filter_logs" {
  stage.drop {
    source = ""
    expression  = ".*Connection closed by authenticating user root" 
    drop_counter_reason = "noisy"
  }
  
  // Forward the processed logs to the writer component
  forward_to = [loki.write.grafana_loki.receiver]
}

// Component 4: Writes logs to Loki
loki.write "grafana_loki" {
  // Use the internal Docker network name for Loki
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
  
  // Add required labels to the output stream
  external_labels = {
    app = "loggerino",
    env = "dev",
  }
}
```

More info on writing alloy configs for `Loki`:

https://grafana.com/docs/alloy/latest/tutorials/send-logs-to-loki/

### B. Run the Alloy Container

Run the Alloy container, giving it access to the configuration file and the `main.log` file via volume mounts.

```bash
docker run -d \
  --name alloy-agent \
  --network monitoring \
  -p 12345:12345 \
  -v "$(pwd)/alloy-config.alloy":/etc/alloy/config.alloy \
  -v logs-volume:/app \
  grafana/alloy:latest \
  run --server.http.listen-addr=0.0.0.0:12345 /etc/alloy/config.alloy
```

- `-v logs-volume:/app`: This mounts the same volume that `loggerino` is using to save logs. That’s how this alloy will be able to scrape those logs from within its container. Then, it sends them to Loki.

### C. Run the Grafana Container

Let’s run Grafana to analyze all logs sent to Loki:

```python
docker run -d \
  --name grafana \
  --network monitoring \
  -p 3000:3000 \
  -v grafana-storage:/var/lib/grafana \
  grafana/grafana-oss
```

---

## 🚀 Testing and Verification

1. **Generate Logs:** Make some calls to the Express app to populate `main.log`:
    
    ```bash
    curl http://localhost:3005/status
    curl http://localhost:3005/error
    curl http://localhost:3005/random
    ```
    
2. **Verify Logs in Loki:** Use the same `curl` command as before to query Loki on port 3100:
    
    ```bash
    # Using your Browser
    http://localhost:3100/loki/api/v1/query_range?query={app=%22loggerino%22}
    
    # Using Curl
    curl -g "http://localhost:3100/loki/api/v1/query_range?query={app=\"loggerino\"}"
    ```
    
    If the setup is correct, you will see a JSON response containing the log streams forwarded by the Alloy agent.
    
3. **Test in Grafana:** Access Grafana url `localhost:3000`, add **Loki** as a Data Source, and try creating some queries (e.g. `{app="loggerino"}`)
4. **Clean Up:** Once done, stop and remove the containers and the network:
    
```bash
docker stop express-app loki alloy-agent
docker rm express-app loki alloy-agent
docker network rm monitoring
```
