/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import net from 'net'
import { isValidPublicAddress } from '../../account/validator'
import { Assert } from '../../assert'
import { GRAFFITI_SIZE } from '../../consensus/consensus'
import { Config } from '../../fileStores/config'
import { Logger } from '../../logger'
import { SerializedBlockTemplate } from '../../serde/BlockTemplateSerde'
import { FileUtils, GraffitiUtils, StringUtils } from '../../utils'
import { ErrorUtils } from '../../utils/error'
import { YupUtils } from '../../utils/yup'
import { MiningPool } from '../pool'
import { mineableHeaderString } from '../utils'
import { ClientMessageMalformedError } from './errors'
import {
  MiningNotifyMessage,
  MiningSetTargetMessage,
  MiningSubmitSchema,
  MiningSubscribedMessage,
  MiningSubscribeSchema,
  StratumMessage,
  StratumMessageSchema,
} from './messages'

export const FIND_USER = 'FIND_USER'
export const FIND_PUBLICK_ADDRESS = 'FIND_PUBLICK_ADDRESS'
export const HASHRATE_EVERYONE_USER = 'HASHRATE_EVERYONE_USER'

let numberOfUsers: number = 0

export class StratumServerClient {
  id: number
  socket: net.Socket
  connected: boolean
  subscribed: boolean
  publicAddress: string | null = null
  graffiti: Buffer | null = null

  private constructor(options: { socket: net.Socket; id: number }) {
    this.id = options.id
    this.socket = options.socket
    this.connected = true
    this.subscribed = false
  }

  static accept(socket: net.Socket, id: number): StratumServerClient {
    return new StratumServerClient({ socket, id })
  }

  close(error?: Error): void {
    if (!this.connected) {
      return
    }

    this.connected = false
    this.socket.removeAllListeners()
    this.socket.destroy(error)
  }
}

export class StratumServer {
  readonly server: net.Server
  readonly pool: MiningPool
  readonly config: Config
  readonly logger: Logger

  publickey: string | null = ''
  allUsersClients: Array<string | null> = []

  readonly port: number
  readonly host: string

  clients: Map<number, StratumServerClient>
  badClients: Set<number>
  nextMinerId: number
  nextMessageId: number

  currentWork: Buffer | null = null
  currentMiningRequestId: number | null = null

  constructor(options: {
    pool: MiningPool
    config: Config
    logger: Logger
    port?: number
    host?: string
  }) {
    this.pool = options.pool
    this.config = options.config
    this.logger = options.logger

    this.host = options.host ?? this.config.get('poolHost')
    this.port = options.port ?? this.config.get('poolPort')

    this.clients = new Map()
    this.badClients = new Set()
    this.nextMinerId = 1
    this.nextMessageId = 1

    this.server = net.createServer((s) => this.onConnection(s))
  }

  async start(): Promise<void> {    
    this.server.listen(this.port, this.host)
    await this.pool.setAllUsersStatusOfline()
    await this.pool.removeOldRecordingsGlobalStatistics()
    await this.pool.removeOldRecordings()
    this.getHashRateForGraphics()
    this.getUserHashRateForGraphics()
    this.addNewUsers()
  }

  stop(): void {
    this.server.close()
  }

  newWork(miningRequestId: number, block: SerializedBlockTemplate): void {
    this.currentMiningRequestId = miningRequestId
    this.currentWork = mineableHeaderString(block.header)

    this.logger.info(
      `Setting work for request: ${this.currentMiningRequestId} ${this.currentWork
        .toString('hex')
        .slice(0, 50)}...`,
    )

    this.broadcast('mining.notify', this.getNotifyMessage())
  }

  waitForWork(): void {
    this.broadcast('mining.wait_for_work')
  }

  hasWork(): boolean {
    return this.currentWork != null
  }

  addBadClient(client: StratumServerClient): void {
    this.badClients.add(client.id)
    this.send(client, 'mining.wait_for_work')
  }

  private onConnection(socket: net.Socket): void {
    const client = StratumServerClient.accept(socket, this.nextMinerId++)

    socket.on('data', (data: Buffer) => {
      this.onData(client, data).catch((e) => this.onError(client, e))
    })

    socket.on('close', () => this.onDisconnect(client))

    socket.on('error', (e) => this.onError(client, e))

    this.logger.debug(`Client ${client.id} connected: ${socket.remoteAddress || 'undefined'}`)
    this.clients.set(client.id, client)
  }

  // Returns the count of connected clients excluding those marked as bad clients
  getClientCount(): number {
    let count = 0
    for (const client of this.clients.keys()) {
      if (this.badClients.has(client)) {
        continue
      }
      count += 1
    }
    return count
  }

  private onDisconnect(client: StratumServerClient): void {
    this.logger.debug(`Client ${client.id} disconnected  (${this.clients.size - 1} total)`)
    this.clients.delete(client.id)
    client.close()
  }

  private async onData(client: StratumServerClient, data: Buffer): Promise<void> {
    const splits = data.toString('utf-8').trim().split('\n')

    for (const split of splits) {
      const payload: unknown = JSON.parse(split)

      const header = await YupUtils.tryValidate(StratumMessageSchema, payload)

      if (header.error) {
        throw new ClientMessageMalformedError(client, header.error)
      }

      this.logger.debug(`Client ${client.id} sent ${header.result.method} message`)

      switch (header.result.method) {
        case 'mining.subscribe': {
          const body = await YupUtils.tryValidate(MiningSubscribeSchema, header.result.body)

          if (body.error) {
            throw new ClientMessageMalformedError(client, body.error, header.result.method)
          }

          client.publicAddress = body.result.publicAddress
          client.subscribed = true

          if (!isValidPublicAddress(client.publicAddress)) {
            throw new ClientMessageMalformedError(
              client,
              `Invalid public address: ${client.publicAddress}`,
              header.result.method,
            )
          }

          const idHex = client.id.toString(16)
          const graffiti = `${this.pool.name}.${idHex}`
          Assert.isTrue(StringUtils.getByteLength(graffiti) <= GRAFFITI_SIZE)
          client.graffiti = GraffitiUtils.fromString(graffiti)

          this.logger.info(`Miner ${idHex} connected (${this.clients.size} total)`)

          this.send(client, 'mining.subscribed', { clientId: client.id, graffiti: graffiti })
          this.send(client, 'mining.set_target', this.getSetTargetMessage())

          if (this.hasWork()) {
            this.send(client, 'mining.notify', this.getNotifyMessage())
          }

          break
        }

        case 'mining.submit': {
          const body = await YupUtils.tryValidate(MiningSubmitSchema, header.result.body)

          if (body.error) {
            throw new ClientMessageMalformedError(client, body.error)
          }

          const submittedRequestId = body.result.miningRequestId
          const submittedRandomness = body.result.randomness

          void this.pool.submitWork(client, submittedRequestId, submittedRandomness)

          break
        }

        default:
          throw new ClientMessageMalformedError(
            client,
            `Invalid message ${header.result.method}`,
          )
      }
    }
  }

  private onError(client: StratumServerClient, error: unknown): void {
    this.logger.debug(
      `Error during handling of data from client ${client.id}: ${ErrorUtils.renderError(
        error,
        true,
      )}`,
    )

    client.socket.removeAllListeners()
    client.close()
    this.clients.delete(client.id)
  }

  private getNotifyMessage(): MiningNotifyMessage {
    Assert.isNotNull(this.currentMiningRequestId)
    Assert.isNotNull(this.currentWork)

    return {
      miningRequestId: this.currentMiningRequestId,
      header: this.currentWork?.toString('hex'),
    }
  }

  private getSetTargetMessage(): MiningSetTargetMessage {
    return {
      target: this.pool.getTarget(),
    }
  }

  private broadcast(method: 'mining.wait_for_work'): void
  private broadcast(method: 'mining.notify', body: MiningNotifyMessage): void
  private broadcast(method: string, body?: unknown): void {
    const message: StratumMessage = {
      id: this.nextMessageId++,
      method: method,
      body: body,
    }

    const serialized = JSON.stringify(message) + '\n'

    this.logger.debug('broadcasting to clients', {
      method,
      id: message.id,
      numClients: this.clients.size,
      messageLength: serialized.length,
    })

    for (const client of this.clients.values()) {
      if (this.badClients.has(client.id)) {
        continue
      }

      if (!client.connected) {
        continue
      }

      client.socket.write(serialized)
    }
    this.logger.debug('completed broadcast to clients', {
      method,
      id: message.id,
      numClients: this.clients.size,
      messageLength: serialized.length,
    })
  }
  private send(
    client: StratumServerClient,
    method: 'mining.notify',
    body: MiningNotifyMessage,
  ): void
  private send(
    client: StratumServerClient,
    method: 'mining.set_target',
    body: MiningSetTargetMessage,
  ): void
  private send(
    client: StratumServerClient,
    method: 'mining.subscribed',
    body: MiningSubscribedMessage,
  ): void
  private send(client: StratumServerClient, method: 'mining.wait_for_work'): void
  private send(client: StratumServerClient, method: string, body?: unknown): void {
    const message: StratumMessage = {
      id: this.nextMessageId++,
      method: method,
      body: body,
    }

    const serialized = JSON.stringify(message) + '\n'
    client.socket.write(serialized)
  }

    // ==================================================================================================

    // Total hashrate of the pool

    getHashRateForGraphics() {
      setInterval(async () => {      
        let hashRateEightHours =  {
          hashRate: {
            rawHashrate: await this.pool.estimateHashRate(),
            processedHashrate: FileUtils.formatHashRate(await this.pool.estimateHashRate())
          },
          data: new Date().getTime()
        }
        this.pool.hashRateForGraphics(hashRateEightHours)
      }, 1800000)
    }
  
    // We get the hashrate of each user
  
    getUserHashRateForGraphics() {
      setInterval(async () => {
        let user = await this.valuesClients(HASHRATE_EVERYONE_USER)      
  
        this.pool.userHashForGraphics(user)
      }, 1800000)
    }
  
    // Adding new users if there are any
    
    addNewUsers() {
      setInterval(() => {
        this.getPoolDB()
      }, 5000)
    }
  
    // FIND_PUBLICK_ADDRESS = we get the hashrate of a certain user counting his shares
    // HASHRATE_EVERYONE_USER = we are looking for all the keys and filtering the repeating ones
  
    async valuesClients(search: string, publicAddress?: string) {
      let users = this.clients.values()
  
      switch (search) {
        case 'FIND_USER':
          for (let user of users) {
            this.publickey = user.publicAddress
          }
          break;
  
        case 'FIND_PUBLICK_ADDRESS':
          for (let user of users) {
            if ( publicAddress === user.publicAddress ) {
              const hashRate = await this.userHashRate(publicAddress)
              return hashRate
            } else {
                continue
              }
            }
            break;
  
        case 'HASHRATE_EVERYONE_USER':
          let user: any = []
          let userDate: Array<{publicAddress: string}> = []
          let allKey: any = []
          let notRepeat: Array<any> = []
  
          for( let user of users ) {
            let publicAddress: string = user.publicAddress || ''
   
            userDate.push({publicAddress})   
            allKey.push(publicAddress)
          }
          
          const address = allKey.filter(function (item: any, position: any, array: any) {
            return array.lastIndexOf(item) === position;
          });
  
          for ( let i = 0; i < address.length; i++) {
            notRepeat.push(address)
          }
  
          for (let key = 0; key < notRepeat.length; key++) {
            let rawHashRateEightHours = await this.pool.userHashRate(notRepeat[0][key])
            let hashRateEightHours = FileUtils.formatHashRate(rawHashRateEightHours)
  
            user.push({publicAddress: notRepeat[0][key], hashRateEightHours, rawHashRateEightHours, data: new Date().getTime()})
          }
  
          return user
      }
    }
  
    async getPoolDB() {
      const online = true
   
      await this.valuesClients(FIND_USER)
   
       numberOfUsers = this.clients.size
       if (numberOfUsers > 0) {
         const usersClients = this.clients.values()    
  
         let timestamp = new Date().getTime()
         let userDate: Array<{publicAddress: string}> = []
         let allKey: any = []
         let user: any = []
         let notRepeat: Array<any> = []
  
         for( let user of usersClients ) {
           let publicAddress: string = user.publicAddress || ''
  
           userDate.push({publicAddress})   
           allKey.push(publicAddress)
         }
         
         const address = allKey.filter(function (item: any, position: any, array: any) {
           return array.lastIndexOf(item) === position;
         });
  
         for ( let i = 0; i < address.length; i++) {
           notRepeat.push(address)
         }
  
         for (let key = 0; key < notRepeat.length; key++) {
           user.push({publicAddress: notRepeat[0][key]})
         }
  
         for( let uniqueAddress = 0; uniqueAddress < user.length; uniqueAddress++ ) {
           const address = user[uniqueAddress].publicAddress
           
           this.pool.setOnlineUser(address);
           this.pool.createUserFields(address, timestamp, online, timestamp)
         }
         return user
       }
     }
  
    async userHashRate(publicAddress?: string) {
      let userHash = await this.pool.userHashRate(publicAddress)
      let hash = userHash
      
      return hash
    }
    
    myLog() {
      return this.clients.size 
    }
  }
  