import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  SubscribeMessage,
} from '@nestjs/websockets';
import { WebSocket, Server } from 'ws';
import * as ws from 'ws';
import Redis from 'ioredis';
import * as url from 'url';
import { v4 as uuidv4 } from 'uuid';
import { ServerMsgCode, ServerMsg } from './protocol/ServerMsg';
import { JwtService } from '@nestjs/jwt';

interface RoomState {
  roomId: string;
  connections: {
    [connectionId: number]: {
      userId: string;
      nonce: string;
      roomId: string;
      client: WebSocket; // 新增字段，保存客户端连接对象
    };
  };
}

@WebSocketGateway({
  path: '/v7',
  cors: {
    origin: '*',
  },
})
export class RoomsGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;

  private roomStates: Map<string, RoomState> = new Map();
  private redis: Redis;
  private pubRedis: Redis;

  constructor(private jwtService: JwtService) {
    this.redis = new Redis('redis://localhost:6379');
    this.pubRedis = new Redis('redis://localhost:6379');
  }

  async afterInit() {
    console.log('Rooms Gateway Initialized with Redis');

    // Subscribe to Redis pub/sub channels for cluster-wide communication
    this.redis.subscribe('rooms_channel', (err) => {
      if (err) {
        console.error('Failed to subscribe: ', err);
      }
    });

    this.redis.on('message', (channel, message) => {
      if (channel === 'rooms_channel') {
        const parsedMessage = JSON.parse(message);
        this.handleBroadcastedMessage(parsedMessage);
      }
    });
  }

  async handleConnection(client: WebSocket, req: any) {
    const parsedUrl = url.parse(req.url, true);

    const roomId = parsedUrl.query['roomId'] as string;
    const token = parsedUrl.query['tok'] as string;
    const jwt = (await this.jwtService.decode(token)) as any;
    const userId = jwt.uid;

    if (userId && roomId) {
      client.on('message', (message: Buffer) => {
        const messageStr = message.toString();
        console.log('Received message from client: ', messageStr);

        // Add ping/pong support to keep the connection alive
        if (messageStr === 'ping') {
          client.send('pong'); // 响应客户端的 ping，回复 pong 消息
          return;
        }

        const parsedMessage = JSON.parse(messageStr);
        // 判断如果是数组，则循环调用 handleClientMessage
        if (Array.isArray(parsedMessage)) {
          parsedMessage.forEach((msg) => {
            this.handleClientMessage(client, msg);
          });
        } else if (typeof parsedMessage === 'object') {
          this.handleClientMessage(client, parsedMessage);
        }
      });

      // 监听客户端关闭事件，执行离开房间的操作
      client.on('close', () => {
        this.handleLeaveRoom(client, { roomId, userId });
      });

      await this.handleJoinRoom(client, { roomId, userId });
    } else {
      client.close();
    }
  }

  async handleClientMessage(client: WebSocket, parsedMessage: any) {
    console.log('Received message from client: ', parsedMessage);
    if (parsedMessage.type === ServerMsgCode.UPDATE_PRESENCE) {
      this.handleUpdatePresence(client, parsedMessage);
    }
  }

  async handleJoinRoom(
    client: WebSocket,
    payload: { roomId: string; userId: string },
  ) {
    const { roomId, userId } = payload;
    let roomState = this.roomStates.get(roomId);

    if (!roomState) {
      roomState = { roomId, connections: {} };
      this.roomStates.set(roomId, roomState);
    }

    // Increment connection ID using Redis to ensure consistency across instances
    const connectionId = await this.pubRedis.incr(
      `room:${roomId}:connectionId`,
    );
    const nonce = uuidv4();
    roomState.connections[connectionId] = { userId, nonce, roomId, client }; // 保存 client

    // Store client connection information in Redis for future communication
    await this.pubRedis.hset(
      `room:${roomId}:connections`,
      connectionId.toString(),
      JSON.stringify({ userId, nonce, roomId }),
    );

    // Attach connectionId to client for future reference
    (client as any).connectionId = connectionId;

    // Send initial ROOM_STATE to the user using RoomsService
    const users = await Promise.all(
      Object.keys(roomState.connections).map(async (connId) => {
        const connection = roomState.connections[parseInt(connId)];
        const roomId = connection.roomId;
        const scopes = await this.getUserScopes(roomId, connection.userId);
        return {
          connectionId: parseInt(connId),
          userId: connection.userId,
          scopes,
        };
      }),
    );

    const roomStateResponse = {
      type: ServerMsgCode.ROOM_STATE, // 使用 ServerMsgCode 枚举
      actor: connectionId,
      nonce: nonce,
      scopes: await this.getUserScopes(roomId, userId),
      users: users.reduce(
        (acc, user) => {
          acc[user.connectionId] = {
            id: user.userId,
            scopes: user.scopes,
          };
          return acc;
        },
        {} as { [key: number]: { id: string; scopes: string[] } },
      ),
    };
    client.send(JSON.stringify(roomStateResponse));

    // Notify other users in the room about the new user joined
    this.broadcastToRoom(roomId, {
      type: ServerMsgCode.USER_JOINED, // 使用 ServerMsgCode 枚举
      actor: connectionId,
      userId,
    });

    console.log(`User ${connectionId},${userId} has join room: ${roomId}`);
    return connectionId;
  }

  @SubscribeMessage('leaveRoom')
  async handleLeaveRoom(
    client: WebSocket,
    payload: { roomId: string; userId: string },
  ) {
    const { roomId, userId } = payload;
    const connectionId = (client as any).connectionId;

    // 获取房间状态
    const roomState = this.roomStates.get(roomId);
    if (roomState && roomState.connections[connectionId]) {
      // 移除内存中的连接信息
      delete roomState.connections[connectionId];

      // 同时从 Redis 中删除连接信息
      await this.pubRedis.hdel(
        `room:${roomId}:connections`,
        connectionId.toString(),
      );

      // 如果房间中已经没有连接，清理房间状态
      if (Object.keys(roomState.connections).length === 0) {
        this.roomStates.delete(roomId);
      }

      // 通知房间内其他用户，该用户已经离开房间
      this.broadcastToRoom(roomId, {
        type: ServerMsgCode.USER_LEFT, // 使用 ServerMsgCode 枚举
        actor: connectionId,
      });

      console.log(`User ${connectionId},${userId} has left room: ${roomId}`);
    }
  }

  @SubscribeMessage('updatePresence')
  async handleUpdatePresence(
    client: WebSocket,
    payload: { roomId: string; connectionId: number; data: any },
  ) {
    // const { roomId, connectionId, data } = payload;
    // this.broadcastToRoom(roomId, {
    //   type: ServerMsgCode.UPDATE_PRESENCE, // 使用 ServerMsgCode 枚举
    //   actor: connectionId,
    //   data,
    // });
  }

  public broadcastToRoom(roomId: string, message: any) {
    // Publish the message to Redis so that other instances can receive it
    this.pubRedis.publish('rooms_channel', JSON.stringify({ roomId, message }));
  }

  private handleBroadcastedMessage(parsedMessage: {
    roomId: string;
    message: any;
  }) {
    const { roomId, message } = parsedMessage;
    const roomState = this.roomStates.get(roomId);

    if (roomState) {
      Object.keys(roomState.connections).forEach((connectionId) => {
        const client = roomState.connections[connectionId].client;
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(message));
        }
      });
    }
  }

  async getUserScopes(roomId: string, userId: string) {
    return ['room:write', 'comments:write'];
  }
}
