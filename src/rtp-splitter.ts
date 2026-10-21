import type { Buffer } from 'node:buffer'
import type { RemoteInfo } from 'node:dgram'
import { createSocket } from 'node:dgram'
import { fromEvent, ReplaySubject } from 'rxjs'
import { map, share, takeUntil } from 'rxjs/operators'
import { bindToPort } from './ports.js'
import { getPayloadType, isRtpMessagePayloadType } from './rtp.js'

export interface SocketTarget {
  port: number
  address?: string
}

export interface RtpMessageDescription {
  isRtpMessage: boolean
  payloadType: number
  info: RemoteInfo
  message: Buffer
}

export type RtpMessageHandler = (
  description: RtpMessageDescription,
) => SocketTarget | null

export class RtpSplitter {
  public readonly socket = createSocket('udp4')
  public readonly portPromise: Promise<number>
  private onClose = new ReplaySubject<any>()
  private readonly abortController = new AbortController()
  private bound = false
  public readonly onMessage = fromEvent<[Buffer, RemoteInfo]>(
    this.socket,
    'message',
  ).pipe(
    map(([message, info]) => {
      const payloadType = getPayloadType(message)

      return {
        message,
        info,
        isRtpMessage: isRtpMessagePayloadType(payloadType),
        payloadType,
      }
    }),
    takeUntil(this.onClose),
    share(),
  )

  constructor(
    messageHandler?: RtpMessageHandler,
    options: {
      portRange?: { start: number, end: number }
    } = {},
  ) {
    this.socket.on('close', this.onSocketClose)
    this.socket.on('error', this.onSocketError)

    this.portPromise = bindToPort(this.socket, {
      portRange: options.portRange,
      signal: this.abortController.signal,
    }).then((port) => {
      this.bound = true

      if (this.closed) {
        this.closeSocket()
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        throw error
      }

      return port
    }, (error: Error) => {
      this.cleanUp()
      if (error.name !== 'AbortError') {
        this.closeSocket()
      }
      throw error
    })
    void this.portPromise.catch(() => {})

    if (messageHandler) {
      this.addMessageHandler(messageHandler)
    }
  }

  addMessageHandler(handler: RtpMessageHandler) {
    this.onMessage.subscribe((description) => {
      const forwardingTarget = handler(description)

      if (forwardingTarget) {
        void this.send(description.message, forwardingTarget).catch(() => {
          this.onSocketError()
        })
      }
    })
  }

  async send(message: Buffer, sendTo: SocketTarget) {
    if (this.closed) {
      return
    }

    if (!this.bound) {
      await this.portPromise
    }

    if (this.closed) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      this.socket.send(message, sendTo.port, sendTo.address || '127.0.0.1', (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }

  private cleanedUp = false
  private onSocketClose = () => {
    this.socketClosed = true
    this.bound = false
    this.cleanUp()
  }

  private onSocketError = () => {
    if (this.bound) {
      this.cleanUp()
      this.closeSocket()
    }
  }

  private socketClosed = false
  private closeSocket() {
    if (this.socketClosed) {
      return
    }

    this.socketClosed = true
    this.bound = false
    try {
      this.socket.close()
    } catch (error) {
      if ((error as Error & { code?: string }).code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
        throw error
      }
    }
  }

  private cleanUp() {
    if (this.cleanedUp) {
      return
    }

    this.cleanedUp = true
    this.closed = true
    this.abortController.abort()
    this.socket.off('close', this.onSocketClose)
    this.socket.off('error', this.onSocketError)
    this.onClose.next(null)
  }

  private closed = false
  close() {
    if (this.closed) {
      return
    }

    this.closed = true
    this.abortController.abort()
    if (this.bound) {
      this.closeSocket()
    }
    this.cleanUp()
  }
}
