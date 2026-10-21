import type { Socket } from 'node:dgram'
import type { AddressInfo } from 'node:net'
import { pickPort } from 'pick-port'

// Need to reserve ports in sequence because ffmpeg uses the next port up by default.  If it's taken, ffmpeg will error
export async function reservePorts({
  count = 1,
  type = 'udp',
  attemptNumber = 0,
}: {
  count?: number
  type?: 'udp' | 'tcp'
  attemptNumber?: number
} = {}): Promise<number[]> {
  if (attemptNumber > 100) {
    throw new Error('Failed to reserve ports after 100 tries')
  }

  const pickPortOptions = {
    type,
    reserveTimeout: 15, // 15 seconds is max setup time for HomeKit streams, so the port should be in use by then
  }
  const port = await pickPort(pickPortOptions)
  const ports = [port]
  const tryAgain = () => {
    return reservePorts({
      count,
      type,
      attemptNumber: attemptNumber + 1,
    })
  }

  for (let i = 1; i < count; i++) {
    try {
      const targetConsecutivePort = port + i
      const openPort = await pickPort({
        ...pickPortOptions,
        minPort: targetConsecutivePort,
        maxPort: targetConsecutivePort,
      })

      ports.push(openPort)
    } catch (_) {
      // can't reserve next port, bail and get another set
      return tryAgain()
    }
  }

  return ports
}

export function bindToPort(
  socket: Socket,
  {
    portRange,
    signal,
  }: {
    portRange?: { start: number, end: number }
    signal?: AbortSignal
  } = {},
) {
  if (
    portRange !== undefined
    && (
      !portRange
      || !Number.isInteger(portRange.start)
      || !Number.isInteger(portRange.end)
      || portRange.start < 1
      || portRange.end > 65535
      || portRange.start > portRange.end
    )
  ) {
    return Promise.reject(new RangeError('portRange must be within 1–65535 and start must not exceed end'))
  }

  return new Promise<number>((resolve, reject) => {
    let settled = false
    const firstPort = portRange?.start ?? 0
    const lastPort = portRange?.end ?? 0
    let onAbort = () => {}

    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const fail = (error: Error) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(error)
    }
    onAbort = () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      fail(error)
    }
    const bind = (port: number) => {
      if (settled) {
        return
      }
      if (signal?.aborted) {
        onAbort()
        return
      }

      let onListening = () => {}
      const onError = (error: Error & { code?: string }) => {
        socket.off('error', onError)
        socket.off('listening', onListening)

        if (settled) {
          socket.close()
          return
        }

        if (signal?.aborted) {
          onAbort()
        } else if (error.code === 'EADDRINUSE' && portRange && port < lastPort) {
          bind(port + 1)
        } else {
          fail(error)
        }
      }
      onListening = () => {
        socket.off('error', onError)
        socket.off('listening', onListening)

        if (settled || signal?.aborted) {
          if (!settled) {
            onAbort()
          }
          socket.close()
          return
        }

        settled = true
        cleanup()
        const { port: boundPort } = socket.address() as AddressInfo
        resolve(boundPort)
      }

      socket.once('listening', onListening)
      socket.once('error', onError)

      try {
        socket.bind(port)
      } catch (error) {
        socket.off('error', onError)
        socket.off('listening', onListening)
        fail(error as Error)
      }
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    bind(firstPort)
  })
}
