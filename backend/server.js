#!/usr/bin/env node
import * as mediasoup from 'mediasoup';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server, Socket } from 'socket.io';

import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client'

import * as jwtModule from './libs/jwt.module.js';
import { createHash } from 'node:crypto';

import swaggerJsDoc from 'swagger-jsdoc';
import * as swaggerUi from 'swagger-ui-express';

import { config } from './config.js';

const prisma = new PrismaClient();
let httpServer;
let expressApp;
let socketServer;
let mediasoupWorker;
let mediasoupRouter;
let producer;
let consumer;
let producerTransport;
let consumerTransport;
// let workers = [];


run()

async function run() {
    await createMediaServer();
    await createExpressApp();
    await createHttpServer();
    await createSocketServer();
}

async function createMediaServer() {
    mediasoupWorker = await mediasoup.createWorker({
        logLevel: config.mediasoup.workerSettings.logLevel,
        logTags: config.mediasoup.workerSettings.logTags,
        rtcMinPort: Number(config.mediasoup.workerSettings.rtcMinPort),
        rtcMaxPort: Number(config.mediasoup.workerSettings.rtcMaxPort)
    });

    mediasoupWorker.on('died', () => {
        console.error(
            `mediasoup Worker [${mediasoupWorker.pid}] died, exiting  in 2 seconds... `);

        setTimeout(() => process.exit(1), 2000);
    });
    const mediaCodecs = config.mediasoup.routerOptions.mediaCodecs;
    mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });


    // TODO: add logger
    // TODO: add multiple workers


}

async function createExpressApp() {
    console.info('creating Express app...');

    expressApp = express();
    expressApp.use(express.json());
    expressApp.use(cors(
        config.corsOptions
    ));

    // Middleware для отлова всех входящих запросов
    expressApp.use((req, res, next) => {
        console.log(`[${req.method}]:`, req.url);
        next(); // Передаем управление следующему middleware в цепочке
    });

    /** 
     * @swagger
     * /api/create-room:
     *   post:
     *     tags:
     *       - Room API
     *     description: Создает комнату и добавляет ее в базу. 
     *     responses:
     *       201:
     *         description: Success
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               example:
     *                   id: 00000000-0000-0000-0000-000000000000
     *                   name: My room
     *                   public: true
     *                   createdAt: 2022-01-01T00:00:00.000Z
     *                   updatedAt: null   
    */
    expressApp.post('/api/create-room', async (req, res) => {
        const room = await prisma.room.create({
            data: {
                name: req.body.name,
                public: req.body.public
            }
        })

        res.status(201).json(room);
    })

    /**
     * @swagger
     * /api/vanish-room:
     *   post:
     *     tags:
     *       - Room API
     *     description: Безвозвратно удаляет комнату из базы.
     *     responses:
     *       204:
     *         description: Success
     */
    expressApp.post('/api/vanish-room/:id', async (req, res) => {
        const room = await prisma.room.findUnique({
            where: { id: req.params.id }
        })

        if (room) {
            await prisma.room.delete({
                where: { id: req.params.id }
            });
        }

        res.sendStatus(204);
    })

    /**
     * @swagger
     * /api/delete-room:
     *   post:
     *     tags:
     *       - Room API
     *     description: Изменяет статус комнаты в базе на удалён (deleted = true).
     *     responses:
     *       204:
     *         description: Success
    */
    expressApp.post('/api/delete-room/:id', async (req, res) => {
        const room = await prisma.room.findUnique({
            where: { id: req.params.id }
        })

        if (room) {
            await prisma.room.update({
                where: { id: req.params.id },
                data: { deleted: true }
            })
        }

        res.sendStatus(204);
    })

    /**
     * @swagger
     * /api/get-room/:id:
     *   get:
     *     tags:
     *       - Room API
     *     description: Возвращает комнату по id.
     *     responses:
     *       200:
     *         description: Success
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     */
    expressApp.get('/api/get-room/:id', async (req, res) => {
        if (!req.params.id || uuidv4().match(req.params.id)) {
            return res.sendStatus(400);
        }

        const room = await prisma.room.findUnique({
            where: { id: req.params.id, deleted: false }
        })

        if (!room) {
            return res.sendStatus(404);
        }

        res.json(room);
    })

    /**
    * @swagger
    * /get-public-rooms-list:
    *   get:
    *     tags:
    *       - Room API
    *     description: Возвращает список комнат.
    *     responses:
    *       200:
    *         description: Success
    *         content:
    *           application/json:
    *             schema:
    *               type: array
    *               example:
    *                 - id: 00000000-0000-0000-0000-000000000000
    *                   name: My room
    *                   public: true
    *                   createdAt: 2022-01-01T00:00:00.000Z
    *                   updatedAt: null
    */
    expressApp.get('/api/get-public-rooms', async (req, res) => {
        const rooms = await prisma.room.findMany({
            where: { public: true, deleted: false }
        })

        res.json(rooms);
    });

    /**
     * @swagger
     * /get-all-rooms-list:
     *   get:
     *     tags:
     *       - Room API
     *     description: Возвращает список комнат.
     *     responses:
     *       200:
     *         description: Success
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               example:
     *                 - id: 00000000-0000-0000-0000-000000000000
     *                   name: My room
     *                   public: true
     *                   createdAt: 2022-01-01T00:00:00.000Z
     *                   updatedAt: null
    */
    expressApp.get('/api/get-all-rooms', async (req, res) => {
        const rooms = await prisma.room.findMany({
            where: { deleted: false }
        })
        res.json(rooms);
    });

    /**
     * @swagger
     * /generate-uuid:
     *   get:
     *     tags:
     *       - Room API
     *     description: Возвращает уникальный идентификатор (uuid v4) комнаты.
     *     responses:
     *       200:
     *         description: Success
     *         content:
     *           application/json:
     *             schema:
     *               type: string
     *               example: 00000000-0000-0000-0000-000000000000
     *        
     */
    expressApp.get('/api/generate-uuid', (req, res) => {
        return res.send(uuidv4());
    });

    // TODO: вернуть нужные данные
    expressApp.post('/api/login', async (req, res) => {
        let email = req.body.email;
        let password = req.body.password;
        let passwordHash = createHash('sha256').update(password).digest('hex');
        console.log(passwordHash);

        const user = await prisma.user.findUnique({
            where: {
                email: email,
                passwordHash: passwordHash,
                // deleted: false
            }
        });

        if (!user) {
            return res.sendStatus(404);
        }

        res.status(200);
        // res.send(
        // {id, username, name, email, regDate, lastMod, token}
        // );
    });

    // TODO: вернуть нужные данные, сразу авторизовать (мб метод написать отдельно)
    expressApp.post('/api/signup', async (req, res) => {
        let email = req.body.email;
        let password = req.body.password;
        let passwordHash = createHash('sha256').update(password).digest('hex');

        const user = await prisma.user.create({
            data: {
                email: email,
                passwordHash: passwordHash
            }
        });

        res.status(200);
    });

    /**
     * @swagger
     * /get-active-rooms:
     *   get:
     *     tags:
     *       - Statistics API
     *     description: Возвращает количество активных комнат.
     *     responses:
     *       200:
     *         description: Success
     */
    expressApp.get('/api/get-active-rooms', async (req, res) => {
        const activeRooms = socketServer.sockets.adapter.rooms;
        // to see rooms: Object.fromEntries(activeRooms)
        res.status(200).json({ "activeRooms": activeRooms.size });
    })

    const swaggerDocs = swaggerJsDoc(config.swaggerOptions);
    expressApp.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));
}

async function createHttpServer() {
    console.info('running HTTP server...');

    httpServer = http.createServer(expressApp);

    await new Promise((resolve) => {
        httpServer.listen(
            Number(config.http.listenPort), config.http.listenIp, resolve);
    });
    console.info(`HTTP server listening on http://127.0.0.1:${config.http.listenPort}`);
}

async function createSocketServer() {
    socketServer = new Server(httpServer, {
        cors: config.corsOptions
    });

    socketServer.on('connection', (socket) => {
        socket.on('joinRoom', async (roomId, callback) => {
            socket.join(roomId);
            socket.to(roomId).emit('user-connected', socket.id);
            console.log(`User with ID: ${socket.id} joined room: ${roomId}`);
            callback(roomId);
        })

        // #region WebRTC
        socket.on('getRouterRtpCapabilities', async (callback) => {
            callback(mediasoupRouter.rtpCapabilities);
        });

        socket.on('createProducerTransport', async (callback) => {
            try {
                const { transport, params } = await createWebRtcTransport();
                producerTransport = transport;
                callback(params);
            } catch (err) {
                console.error(err);
                callback({ error: err.message });
            }
        });

        socket.on('createConsumerTransport', async (callback) => {
            try {
                const { transport, params } = await createWebRtcTransport();
                consumerTransport = transport;
                callback(params);
            } catch (err) {
                console.error(err);
                callback({ error: err.message });
            }
        });

        socket.on('connectProducerTransport', async (data) => {
            await producerTransport.connect({ dtlsParameters: data.dtlsParameters });
        });

        socket.on('connectConsumerTransport', async (data) => {
            await consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
        });

        socket.on('produce', async (data, callback) => {
            const { kind, rtpParameters } = data;
            producer = await producerTransport.produce({ kind, rtpParameters });
            callback({ id: producer.id });

            socket.broadcast.emit('newProducer');
        });

        socket.on('consume', async (data, callback) => {
            if (!mediasoupRouter.canConsume(
                {
                    producerId: producer.id,
                    rtpCapabilities: data.rtpCapabilities,
                })
            ) {
                console.error('can not consume');
                return;
            }
            try {
                consumer = await consumerTransport.consume({
                    producerId: producer.id,
                    rtpCapabilities: data.rtpCapabilities,
                    paused: true,
                });
            } catch (error) {
                console.error('consume failed', error);
                return;
            }

            if (consumer.type === 'simulcast') {
                await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
            }

            callback({
                producerId: producer.id,
                id: consumer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                type: consumer.type,
                producerPaused: true
            });
        });

        socket.on('resume', async (data) => {
            await consumer.resume();
            console.log("resumed");
        });

        //#endregion

        // #region Chat

        socket.on("message", (data) => {
            socket.to(data.roomId).emit("message", data);
        })

        // #endregion
    })
}

async function createWebRtcTransport() {
    const {
        maxIncomingBitrate,
        initialAvailableOutgoingBitrate
    } = config.mediasoup.webRtcTransportOptions;

    const transport = await mediasoupRouter.createWebRtcTransport({
        listenIps: config.mediasoup.webRtcTransportOptions.listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate,
    });
    if (maxIncomingBitrate) {
        try {
            await transport.setMaxIncomingBitrate(maxIncomingBitrate);
        } catch (error) {
        }
    }
    return {
        transport,
        params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters
        },
    };
}