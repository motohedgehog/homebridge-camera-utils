import { Buffer } from 'node:buffer'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { bindToPort, RtpSplitter } from '../src/index.js'

const splitters: RtpSplitter[] = []
const sockets: ReturnType<typeof createSocket>[] = []

async function closeSocket(socket: ReturnType<typeof createSocket>) {
  await new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

function waitForSocketClose(socket: ReturnType<typeof createSocket>) {
  return new Promise<void>(resolve => socket.once('close', resolve))
}

afterEach(async () => {
  for (const splitter of splitters.splice(0)) {
    splitter.close()
  }

  await Promise.all(sockets.splice(0).map(closeSocket))
})

function createTrackedSocket() {
  const socket = createSocket('udp4')
  sockets.push(socket)
  return socket
}

async function getUnusedPort() {
  const socket = createTrackedSocket()
  socket.bind(0)
  await once(socket, 'listening')
  const { port } = socket.address()
  await closeSocket(socket)
  sockets.splice(sockets.indexOf(socket), 1)
  return port
}

async function bindSocket(socket: ReturnType<typeof createSocket>, port: number) {
  await new Promise<void>((resolve, reject) => {
    let onError = (error: Error) => reject(error)
    const onListening = () => {
      socket.off('error', onError)
      resolve()
    }
    onError = (error) => {
      socket.off('listening', onListening)
      reject(error)
    }
    socket.once('listening', onListening)
    socket.once('error', onError)
    socket.bind(port)
  })
}

async function getUnusedPortRange(length: number) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const start = await getUnusedPort()
    if (start + length > 65536) {
      continue
    }

    const probes = Array.from({ length }, createTrackedSocket)
    try {
      for (let offset = 0; offset < length; offset++) {
        await bindSocket(probes[offset], start + offset)
      }
      await Promise.all(probes.map(closeSocket))
      for (const probe of probes) {
        sockets.splice(sockets.indexOf(probe), 1)
      }
      return start
    } catch {
      await Promise.all(probes.map(closeSocket))
      for (const probe of probes) {
        sockets.splice(sockets.indexOf(probe), 1)
      }
    }
  }

  throw new Error('Unable to find a free UDP port range for the test')
}

describe('rtp splitter', () => {
  it('binds in the requested range and forwards UDP packets', async () => {
    const port = await getUnusedPort()
    const receiver = createTrackedSocket()
    receiver.bind(0)
    await once(receiver, 'listening')

    const splitter = new RtpSplitter(
      () => ({ port: receiver.address().port }),
      { portRange: { start: port, end: port } },
    )
    splitters.push(splitter)

    expect(await splitter.portPromise).toBe(port)

    const packet = Buffer.from([0x80, 0x60, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2])
    const received = once(receiver, 'message')
    createTrackedSocket().send(packet, port, '127.0.0.1')

    const [message] = await received
    expect(message).toEqual(packet)
  })

  it('retries an occupied port and forwards packets from the next port', async () => {
    const port = await getUnusedPortRange(2)
    const occupied = createTrackedSocket()
    await bindSocket(occupied, port)

    const receiver = createTrackedSocket()
    await bindSocket(receiver, 0)
    const splitter = new RtpSplitter(
      () => ({ port: receiver.address().port }),
      { portRange: { start: port, end: port + 1 } },
    )
    splitters.push(splitter)

    expect(await splitter.portPromise).toBe(port + 1)

    const packet = Buffer.from([0x80, 0x60, 0, 0, 0, 0, 0, 3, 0, 0, 0, 4])
    const received = once(receiver, 'message')
    const sender = createTrackedSocket()
    await new Promise<void>((resolve, reject) => {
      sender.send(packet, port + 1, '127.0.0.1', error => error ? reject(error) : resolve())
    })

    const [message] = await received
    expect(message).toEqual(packet)
  })

  it('rejects an exhausted range and releases the failed binding', async () => {
    const port = await getUnusedPort()
    const occupied = createTrackedSocket()
    await bindSocket(occupied, port)
    const splitter = new RtpSplitter(undefined, { portRange: { start: port, end: port } })
    splitters.push(splitter)
    const socketClosed = waitForSocketClose(splitter.socket)

    await expect(splitter.portPromise).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await socketClosed
    splitter.close()
    splitter.close()

    await closeSocket(occupied)
    sockets.splice(sockets.indexOf(occupied), 1)
    const reused = new RtpSplitter(undefined, { portRange: { start: port, end: port } })
    splitters.push(reused)

    expect(await reused.portPromise).toBe(port)
  })

  it('allocates distinct ports for simultaneous splitters in one range', async () => {
    const start = await getUnusedPortRange(2)
    const range = { start, end: start + 1 }
    const first = new RtpSplitter(undefined, { portRange: range })
    const second = new RtpSplitter(undefined, { portRange: range })
    splitters.push(first, second)

    const ports = await Promise.all([first.portPromise, second.portPromise])
    expect(new Set(ports).size).toBe(2)
    expect(ports.every(port => port >= start && port <= range.end)).toBe(true)
  })

  it('cancels a pending bind safely and permits repeated close', async () => {
    const port = await getUnusedPort()
    const splitter = new RtpSplitter(undefined, { portRange: { start: port, end: port } })
    splitters.push(splitter)
    const socketClosed = waitForSocketClose(splitter.socket)

    splitter.close()
    splitter.close()

    await expect(splitter.portPromise).rejects.toMatchObject({ name: 'AbortError' })
    await socketClosed
  })

  it('does not resolve the port promise when closed during listening', async () => {
    const port = await getUnusedPort()
    const splitter = new RtpSplitter(undefined, { portRange: { start: port, end: port } })
    splitters.push(splitter)
    const socketClosed = waitForSocketClose(splitter.socket)
    splitter.socket.once('listening', () => splitter.close())

    await expect(splitter.portPromise).rejects.toMatchObject({ name: 'AbortError' })
    await socketClosed
  })

  it('closes a cancelled bind when the requested port is occupied', async () => {
    const occupied = createTrackedSocket()
    await bindSocket(occupied, 0)
    const port = occupied.address().port
    const splitter = new RtpSplitter(undefined, { portRange: { start: port, end: port } })
    splitters.push(splitter)
    const socketClosed = waitForSocketClose(splitter.socket)

    splitter.close()

    await expect(splitter.portPromise).rejects.toMatchObject({ name: 'AbortError' })
    await socketClosed
  }, 1000)

  it('keeps random port allocation as the default', async () => {
    const splitter = new RtpSplitter()
    splitters.push(splitter)

    const port = await splitter.portPromise
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
    expect(splitter.socket.address().port).toBe(port)
  })

  it.each([
    { start: 0, end: 1 },
    { start: 1, end: 65536 },
    { start: 2, end: 1 },
    { start: 1.5, end: 2 },
  ])('rejects invalid port range $start–$end', async (portRange) => {
    const splitter = new RtpSplitter(undefined, { portRange })
    splitters.push(splitter)

    await expect(splitter.portPromise).rejects.toBeInstanceOf(RangeError)
    splitter.close()
  })

  it('rejects a null port range instead of using random allocation', async () => {
    const splitter = new RtpSplitter(undefined, { portRange: null as never })
    splitters.push(splitter)

    await expect(splitter.portPromise).rejects.toBeInstanceOf(RangeError)
  })

  it('propagates non-address-in-use bind errors without retrying', async () => {
    const socket = createTrackedSocket()
    await bindSocket(socket, 0)

    await expect(
      bindToPort(socket, { portRange: { start: 1024, end: 1025 } }),
    ).rejects.toMatchObject({ code: 'ERR_SOCKET_ALREADY_BOUND' })
  })
})
