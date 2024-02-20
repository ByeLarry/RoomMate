#!/usr/bin/env node
import * as mediasoup from 'mediasoup';
import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import nunjucks from 'nunjucks';

// import config.js file
import { config } from './config.js';
import { execPath } from 'process';

const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000,
        },
    },
]

// Map of Room instances indexed by roomId.
// @type {Map<Number, Room>}
const rooms = new Map();

// WebSocket server.
let io;

let worker
let router
let producerTransport
let consumerTransport
let producer
let consumer

// HTTPS server.
// @type {https.Server}
let httpServer;

// Express application.
// @type {Function}
let expressApp;

// WebSocket server.
let webSocketServer;

// mediasoup Workers.
// @type {Array<mediasoup.Worker>}
const mediasoupWorkers = [];

// Index of next mediasoup Worker to use.
// @type {Number}
let nextMediasoupWorkerIdx = 0;

run();

async function run() {
    // Run a mediasoup Worker.
    await runMediasoupWorkers();

    // Create Express app.
    await createExpressApp();

    // Run HTTPS server.
    await runHttpsServer();

    // Run a protoo WebSocketServer.
    await runWebSocketServer();

    // Log rooms status every X seconds.
    setInterval(() => {
        for (const room of rooms.values()) {
            room.logStatus();
        }
    }, 120000);
}

async function runMediasoupWorkers() {
    const { numWorkers } = config.mediasoup;

    console.info('running %d mediasoup Workers...', numWorkers);
    const webRtcServerOptions = config.mediasoup.webRtcServerOptions;

    for (let i = 0; i < numWorkers; ++i) {
        const worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.workerSettings.logLevel,
            logTags: config.mediasoup.workerSettings.logTags,
            rtcMinPort: config.mediasoup.workerSettings.rtcMinPort,
            rtcMaxPort: config.mediasoup.workerSettings.rtcMaxPort
        });

        mediasoupWorkers.push(worker);

        worker.on('died', () => {
            console.error('mediasoup Worker died, exiting in 2 seconds... [pid:%d]', worker.pid);

            setTimeout(() => process.exit(1), 2000);
        });

        // Each mediasoup Worker will run its own WebRtcServer, so those cannot
        // share the same listening ports. Hence we increase the value in config.js
        // for each Worker.
        const portIncrement = mediasoupWorkers.length - 1;

        for (const listenInfo of webRtcServerOptions.listenInfos) {
            listenInfo.port += portIncrement;
            console.log(`mediasoup Worker ${worker.pid} is listening on ${listenInfo.ip}:${listenInfo.port}`);
        }

        const webRtcServer = await worker.createWebRtcServer(webRtcServerOptions);

        worker.appData.webRtcServer = webRtcServer;
    };

    console.info('all mediasoup Workers have been started');

}

async function createExpressApp() {
    console.info('creating Express app...');

    expressApp = express();

    nunjucks.configure('templates', {
        autoescape: true,
        express: expressApp
    })

    expressApp.set('view engine', 'html')
    expressApp.use(express.static('static'));
    expressApp.get('/', (req, res) => {
        res.render('index', {
            title: 'mediasoup'
        })
    })
}

async function runHttpsServer() {
    console.info('running HTTPS server...');

    httpServer = http.createServer(expressApp);

    await new Promise((resolve) => {
        httpServer.listen(
            Number(config.https.listenPort), config.https.listenIp, resolve);
    });

    console.info(`HTTPS server listening on 127.0.0.1:${config.https.listenPort}`);
}

async function runWebSocketServer() {
    console.info('running WebSocket server...');

    io = new Server(httpServer);

    io.on('connection', async (socket) => {
        console.log(socket.id)
        socket.emit('connection-success', {
            socketId: socket.id
        })

        socket.on('disconnect', () => {
            // do some cleanup
            console.log('peer disconnected')
        })

        // worker.createRouter(options)
        // options = { mediaCodecs, appData }
        // mediaCodecs -> defined above
        // appData -> custom application data - we are not supplying any
        // none of the two are required
        for (const worker of mediasoupWorkers) {
            router = await worker.createRouter({ mediaCodecs, })
        }

        // Client emits a request for RTP Capabilities
        // This event responds to the request
        socket.on('getRtpCapabilities', (callback) => {

            const rtpCapabilities = router.rtpCapabilities

            console.log('rtp Capabilities', rtpCapabilities)

            // call callback from the client and send back the rtpCapabilities
            callback({ rtpCapabilities })
        })

        // Client emits a request to create server side Transport
        // We need to differentiate between the producer and consumer transports
        socket.on('createWebRtcTransport', async ({ sender }, callback) => {
            console.log(`Is this a sender request? ${sender}`)
            // The client indicates if it is a producer or a consumer
            // if sender is true, indicates a producer else a consumer
            if (sender)
                producerTransport = await createWebRtcTransport(callback)
            else
                consumerTransport = await createWebRtcTransport(callback)
        })

        // see client's socket.emit('transport-connect', ...)
        socket.on('transport-connect', async ({ dtlsParameters }) => {
            console.log('DTLS PARAMS... ', { dtlsParameters })
            await producerTransport.connect({ dtlsParameters })
        })

        // see client's socket.emit('transport-produce', ...)
        socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
            // call produce based on the prameters from the client
            producer = await producerTransport.produce({
                kind,
                rtpParameters,
            })

            console.log('Producer ID: ', producer.id, producer.kind)

            producer.on('transportclose', () => {
                console.log('transport for this producer closed ')
                producer.close()
            })

            // Send back to the client the Producer's id
            callback({
                id: producer.id
            })
        })

        // see client's socket.emit('transport-recv-connect', ...)
        socket.on('transport-recv-connect', async ({ dtlsParameters }) => {
            console.log(`DTLS PARAMS: ${dtlsParameters}`)
            await consumerTransport.connect({ dtlsParameters })
        })

        socket.on('consume', async ({ rtpCapabilities }, callback) => {
            try {
                // check if the router can consume the specified producer
                if (router.canConsume({
                    producerId: producer.id,
                    rtpCapabilities
                })) {
                    // transport can now consume and return a consumer
                    consumer = await consumerTransport.consume({
                        producerId: producer.id,
                        rtpCapabilities,
                        paused: true,
                    })

                    consumer.on('transportclose', () => {
                        console.log('transport close from consumer')
                    })

                    consumer.on('producerclose', () => {
                        console.log('producer of consumer closed')
                    })

                    // from the consumer extract the following params
                    // to send back to the Client
                    const params = {
                        id: consumer.id,
                        producerId: producer.id,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                    }

                    // send the parameters to the client
                    callback({ params })
                }
            } catch (error) {
                console.log(error.message)
                callback({
                    params: {
                        error: error
                    }
                })
            }
        })

        socket.on('consumer-resume', async () => {
            console.log('consumer resume')
            await consumer.resume()
        })
    })
}

async function createWebRtcTransport(callback) {
    try {
        // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
        const webRtcTransport_options = {
            listenIps: [
                {
                    ip: '0.0.0.0', // replace with relevant IP address
                    announcedIp: '127.0.0.1',
                }
            ],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        }

        // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
        let transport = await router.createWebRtcTransport(webRtcTransport_options)
        console.log(`transport id: ${transport.id}`)

        transport.on('close', () => {
            console.log('transport closed')
        })

        // send back to the client the following prameters
        callback({
            // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
            params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            }
        })

        return transport

    } catch (error) {
        console.log(error)
        callback({
            params: {
                error: error
            }
        })
    }
}