/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Database, open } from 'sqlite'
import sqlite3 from 'sqlite3'
import { Config } from '../../fileStores/config'
import { NodeFileProvider } from '../../fileSystems/nodeFileSystem'
import { Logger } from '../../logger'
import { transactionReceives } from '../poolShares'
import { Migrator } from './migrator'

export class PoolDatabase {
  private readonly db: Database
  private readonly config: Config
  private readonly migrations: Migrator
  private readonly attemptPayoutInterval: number
  private readonly successfulPayoutInterval: number

  constructor(options: { db: Database; config: Config; logger: Logger }) {
    this.db = options.db
    this.config = options.config
    this.migrations = new Migrator({ db: options.db, logger: options.logger })
    this.attemptPayoutInterval = this.config.get('poolAttemptPayoutInterval')
    this.successfulPayoutInterval = this.config.get('poolSuccessfulPayoutInterval')
  }

  static async init(options: { config: Config; logger: Logger }): Promise<PoolDatabase> {
    const fs = new NodeFileProvider()
    await fs.init()

    const poolFolder = fs.join(options.config.dataDir, '/pool')
    await fs.mkdir(poolFolder, { recursive: true })

    const db = await open({
      filename: fs.join(poolFolder, '/database.sqlite'),
      driver: sqlite3.Database,
    })

    return new PoolDatabase({
      db,
      logger: options.logger,
      config: options.config,
    })
  }

  async start(): Promise<void> {
    await this.migrations.migrate()
  }

  async stop(): Promise<void> {
    await this.db.close()
  }

  async newShare(publicAddress: string): Promise<void> {
    await this.db.run('INSERT INTO share (publicAddress) VALUES (?)', publicAddress)
  }

  async getSharesForPayout(timestamp: number): Promise<DatabaseShare[]> {
    return await this.db.all(
      "SELECT * FROM share WHERE payoutId IS NULL AND createdAt < datetime(?, 'unixepoch')",
      timestamp,
    )
  }

  async newPayout(timestamp: number): Promise<number | null> {
    // Create a payout row if the most recent succesful payout was greater than the payout interval
    // and the most recent payout was greater than the attempt interval, in case of failed or long
    // running payouts.
    const successfulPayoutCutoff = timestamp - this.successfulPayoutInterval
    const attemptPayoutCutoff = timestamp - this.attemptPayoutInterval

    const query = `
       INSERT INTO payout (succeeded)
         SELECT FALSE WHERE
           NOT EXISTS (SELECT * FROM payout WHERE createdAt > datetime(?, 'unixepoch') AND succeeded = TRUE)
           AND NOT EXISTS (SELECT * FROM payout WHERE createdAt > datetime(?, 'unixepoch'))
     `

    const result = await this.db.run(query, successfulPayoutCutoff, attemptPayoutCutoff)
    if (result.changes !== 0 && result.lastID != null) {
      return result.lastID
    }

    return null
  }

  async markPayoutSuccess(id: number, timestamp: number): Promise<void> {
    await this.db.run('UPDATE payout SET succeeded = TRUE WHERE id = ?', id)
    await this.db.run(
      "UPDATE share SET payoutId = ? WHERE payoutId IS NULL AND createdAt < datetime(?, 'unixepoch')",
      id,
      timestamp,
    )
  }

  async shareCountSince(timestamp: number): Promise<number> {
    const result = await this.db.get<{ count: number }>(
      "SELECT COUNT(id) AS count FROM share WHERE createdAt > datetime(?, 'unixepoch')",
      timestamp,
    )
    if (result == null) {
      return 0
    }
    return result.count
  }
  async createUserFields(publicAddress: string | null, timestamp: any, online: boolean, lastMining: any): Promise<void> {
    let isAdd = true
    const existingUser = await this.db.all('SELECT publicAddress FROM farmer')

    for(let address in existingUser) {
      if (existingUser[address].publicAddress === publicAddress) {
        isAdd = false
          return
      }
    }

    if (isAdd) {
      this.db.run(`INSERT INTO farmer (publicAddress, timestamp, online, lastMining) VALUES(?,?,?,?)`,
                   [publicAddress, timestamp, online, lastMining])
    }
   }

  async setOfflineUser(publicAddress: string, time: number) {
    this.db.run(`UPDATE farmer SET online = 0,	lastMining = ? WHERE publicAddress = ?`,[time, publicAddress])
  }

  async setOnlineUser(publicAddress: string) {
    this.db.run(`UPDATE farmer SET online = 1 WHERE publicAddress = ?`, publicAddress)
  }

  async informationAboutTheBlock(condition: any, time: string | number) {
    console.log('file: database.ts',' main condition: ', condition, '\ncondition.hashed: ', condition.hashedHeader, '\ncondition.height: ', condition.height );
    this.db.run(`INSERT INTO transactions (block, height, timestamp) VALUES(?,?,?)`, [condition.hashedHeader, condition.height, time])
  }

  async shareCount(timestamp: number, publicAddress: string | null | undefined): Promise<number> {
    const result = await this.db.get<{ count: number }>(
      "SELECT COUNT(id) AS count FROM share WHERE publicAddress = ? AND createdAt > datetime(?, 'unixepoch')",
      publicAddress,
      timestamp,
    )

    if (result == null) {
      return 0
    }
    return result.count
  }

  // Adding the amount paid to the user's balance
  async howMuchWasPaid( transaction: transactionReceives ) {
    console.log(transaction)
    await this.db.run(`UPDATE farmer SET amount = amount + ? WHERE publicAddress = ?`, [transaction.amount, transaction.publicAddress])
  }

  // How much was paid to each user
  async getAmountUser(publicAddress: string) {
    return this.db.all('SELECT amount FROM farmer WHERE publicAddress = ?', [publicAddress])
  }

  // The amount that was paid to the entire pool
  async getTheTotalPayoutOfThePool(){
    return this.db.all(`SELECT amount FROM farmer`)
  }

  // We get the hashrate of the pool in 15 minutes
  async gethashRateFifteenMinutes() {
    return await this.db.all(`SELECT * FROM eightHours`)
  }

  // We record the hashrate every 15 minutes
  async hashRateForGraphics(hashRateFifteenMinutes: any) {
    await this.db.run(`INSERT INTO eightHours (hashCount,rawHashCount, timestamp) VALUES(?,?,?)`, hashRateFifteenMinutes.hashRate.processedHashrate, hashRateFifteenMinutes.hashRate.rawHashrate, hashRateFifteenMinutes.data)
  }

  // We record the hashrate of each user in 15 minutes
  async userHashForGraphics(date: Array<any>) {
    for(let i = 0; i < date.length; i++) {       
     await this.db.run(`INSERT INTO userEightHours (publicAddress, hashCount,rawHashCount, timestamp) VALUES(?,?,?,?)`, [date[i].publicAddress, date[i].hashRateEightHours,date[i].rawHashRateEightHours, date[i].data])
    }
  }

  // We get the hashrate of a specific user
  async getUserHashRateGraphics(publicAddress: string) {
    return await this.db.all(`SELECT * FROM userEightHours WHERE publicAddress = ?`, [publicAddress])
  }

  /*
   !!!!!!Use only when needed!!!!!!!

   Deleting the hashrate for a chart for all users
  */
  async removeOldRecordUserEightHours() {
    await this.db.run(`DELETE FROM userEightHours`)
  }

  /*
   !!!!!!Use only when needed!!!!!!!

   Deletes all entries of the total hashrate of the pool for the chart
  */
  async removeOldRecordEightHours() {  
    await this.db.run(`DELETE FROM eightHours`)
  }

  async setAllUsersStatusOfline() {
    const sql = `UPDATE farmer SET online = 0`
    await this.db.run(sql)
  }

  async findUserByPublicAddress (publicAddress: string) {
   const sql = 'SELECT * FROM farmer WHERE publicAddress = ?'
   return await this.db.all(sql, publicAddress)
  }

  async dropTable() {
    await this.db.run('DROP TABLE paidCoins;')
  }

  async createTable() {
    await this.db.run(`
    CREATE TABLE paidCoins (
      id INTEGER PRIMARY KEY,
      publicAddress TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      timestamp STRING NOT NULL DEFAULT CURRENT_TIMESTAMP,
      createdAt INTEGER NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `) 
 }

  async getTransaction() {
    return await this.db.all('SELECT * FROM transactions')
  }

  async setTheUserPayout(successfulTransaction: recordThePayout) {
    const sql = 'INSERT INTO paidCoins (publicAddress, amount, timestamp, createdAt) VALUES (?,?,?,?)'
    await this.db.run(sql, [
                            successfulTransaction.publicAddress, successfulTransaction.amount,
                            successfulTransaction.timestamp, successfulTransaction.createdAt
                           ])
 }

  async getTheUserPayout(publicAddress: string): Promise<any> {
    return await this.db.all(`SELECT * FROM paidCoins WHERE publicAddress = ?`, publicAddress)
  }

  async totalUsers() {
    return await this.db.all(`SELECT COUNT(*) as c FROM farmer WHERE online = 1 `)
  }

  async getAllUsers() {
    return await this.db.all('SELECT * FROM farmer')
  }

  async getAllBlock() {
    return await this.db.all('SELECT * FROM transactions')
  }

  async getPaidCoins() {
    return await this.db.all('SELECT * FROM paidCoins')
  }

  async getAllShares() {
    return await this.db.all('SELECT * FROM share')
  }

  async getAllPayout() {
    return await this.db.all('SELECT * FROM payout')
  }

  async setAllUsers(transaction: {block: string, height: string, timestamp: number}) {
    await this.db.run(`INSERT INTO transactions (block, height, timestamp) VALUES (?,?,?)`, 
      transaction.block,
      transaction.height,
      transaction.timestamp
    )
  }

  async deletedDontNeedsBlock() {
    await this.db.run('DELETE from share')
  }
}

export type DatabaseShare = {
  id: number
  publicAddress: string
  createdAt: Date
  payoutId: number | null
}

export type recordThePayout = {
  publicAddress: string
  amount: number | string
  timestamp: number
  createdAt: string
}
