import http from "http";
import express from "express";
import Docker from "dockerode";
import dotenv from "dotenv";
import httpProxy from "http-proxy";

dotenv.config();
const PORT = process.env.PORT;
const proxyPort = process.env.PROXY_PORT;

const managementAPI = express();
managementAPI.use(express.json());

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const db = new Map(); //in-memory DB to keep track of the spun up containers for faster access/proxy.
const proxy = httpProxy.createProxy({});

//listening to container events & registering them
docker.getEvents(function (err, stream) {
    if (err) {
        console.log(`Err in getting events`, err);
        return;
    }

    stream.on('data', async (chunk) => {
        try {
            if (!chunk) return;

            const event = JSON.parse(chunk.toString());
            if (event.Type === 'container' && event.Action === 'start') {
                const container = docker.getContainer(event.id);
                const containerInfo = await container.inspect();

                const containerName = containerInfo.Name.substring(1); //removing default starting '/' in name of docker container
                const ipAddress = containerInfo.NetworkSettings.IPAddress;

                const exposedPort = Object.keys(containerInfo.Config.ExposedPorts);
                let defaultPort = null;

                if (exposedPort && exposedPort.length > 0) {
                    const [port, type] = exposedPort[0].split('/');
                    if (type === 'tcp') { //proxying only TCP ports
                        defaultPort = port;
                    }
                }

                console.log(`Registering ${containerName}.localhost --> http://${ipAddress}:${defaultPort}`);
                db.set(containerName, { containerName, ipAddress, defaultPort });
                //console.log(db);
            }
        } catch (err) {
            console.log(err);
        }
    });
});


/*Creating a Reverse Proxy through Docker*/
const reverseProxyApp = express();

reverseProxyApp.use(function (req, res) {
    const hostname = req.hostname;
    const subdomain = hostname.split('.')[0];
    
    console.log(`Received request for hostname: ${hostname}`);
    
    if (!db.has(subdomain)) {
        console.error(`No entry found in db for subdomain: ${subdomain}`);
        return res.status(404).end('404 Not Found'); // Updated message for clarity
    }

    const { ipAddress, defaultPort } = db.get(subdomain);

    const target = `http://${ipAddress}:${defaultPort}`;
    console.log(`Forwarding ${hostname} --> ${target}`);

    // Add error handling to capture any proxy errors
    proxy.web(req, res, { target, changeOrigin: true, ws: true }, (err) => {
        if (err) {
            console.error(`Error proxying request to ${target}:`, err);
            res.status(500).send('Proxy error occurred');
        }
    });
});

const reverseProxy = http.createServer(reverseProxyApp); //new proxy service which will listen all requests from any port & proxy them to port:80
//handling websocket updates
reverseProxy.on('upgrade', (req, socket, head) => {
    const hostname = req.headers.host;
    const subdomain = hostname.split('.')[0];

    console.log(`Handling WebSocket upgrade for hostname: ${hostname}`);

    if (!db.has(subdomain)) {
        console.error(`No entry found in db for WebSocket subdomain: ${subdomain}`);
        return socket.destroy(); // Close socket connection if no matching subdomain
    }

    const { ipAddress, defaultPort } = db.get(subdomain);
    const target = `http://${ipAddress}:${defaultPort}`;

    console.log(`Forwarding WebSocket ${hostname} --> ${target}`);

    proxy.ws(req, socket, head, { target, ws: true }, (err) => {
        if (err) {
            console.error(`Error forwarding WebSocket to ${target}:`, err);
            socket.destroy(); // Close socket if there is a proxy error
        }
    });
});


managementAPI.post("/containers", async (req, res) => {
    const { image, tag = "latest" } = req.body;

    let imageAlreadyExists = false;

    // Checking if the image already exists locally
    const images = await docker.listImages();
    for (const systemImage of images) {
        if (systemImage.RepoTags && systemImage.RepoTags.includes(`${image}:${tag}`)) {
            imageAlreadyExists = true;
            break;
        }
    }

    if (!imageAlreadyExists) {
        try {
            console.log(`Pulling Image: ${image}:${tag}`);
            await new Promise((resolve, reject) => {
                docker.pull(`${image}:${tag}`, (err, stream) => {
                    if (err) return reject(err);
                    docker.modem.followProgress(stream, (err, output) => err ? reject(err) : resolve(output));
                });
            });
        } catch (err) {
            console.error(`Error pulling image: ${image}:${tag}`, err);
            return res.status(500).json({ error: 'Failed to pull image' });
        }
    }

    try {
        // Creating new container without attempting to pull the image again
        const container = await docker.createContainer({
            Image: `${image}:${tag}`,
            Tty: false,
            HostConfig: {
                AutoRemove: true
            }
        });

        await container.start();
        return res.json({ status: 'success', container: `${(await container.inspect()).Name}.localhost` });
    } catch (err) {
        console.error('Error creating or starting container:', err);
        return res.status(500).json({ error: 'Failed to create or start container' });
    }
});


managementAPI.listen(PORT, () => {
    console.log(`Management API is running on PORT ${PORT}`);
});

reverseProxy.listen(proxyPort, () => {
    console.log(`Reverse Proxy is running on PORT ${proxyPort}`);
})