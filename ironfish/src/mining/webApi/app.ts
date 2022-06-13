import { Config } from "../../fileStores"
import { MiningPool } from '../pool';
import { IronfishRpcClient} from '../../rpc/clients'
import { FileUtils } from '../../utils/file'
import { FIND_PUBLICK_ADDRESS, StratumServer } from "../stratum/stratumServer"
import { Meter } from "../../metrics";
import {  oreToIron } from "../../utils";
import fs from 'fs'

require('dotenv').config()
const cors = require('cors')
const express = require('express')
const app = express()
const path = require('path')
const bodyParser = require('body-parser');

const corsOptions = {
    origin: 'http://192.168.1.147:5554',
    optionsSuccessStatus: 200 // For legacy browser support
}

app.use(cors(corsOptions))
app.use(cors({ origin: "http://192.168.1.147:5554", credentials: true }));

app.use(express.urlencoded({extended: true}))
app.use(express.static(path.join('/var/www/frontend/iron-pool/dist')))
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// app.use((req:any, res:any, next:any) => {
//   const allowedOrigins = ['https://iron-pool.com', 'https.iron-pool.com/dashboard/', 'http://192.168.1.147:5554'];
//   const origin = req.headers.origin;
//   if (allowedOrigins.includes(origin)) {
//     res.setHeader('Access-Control-Allow-Origin', origin);
//   }
//   return next();
// });

const port = Number(process.env.PORT) || 5554;
const host = '192.168.1.147';

const mainStateJSON = '/home/iron/Рабочий стол/ironfish_0.1.366/ironfish/ironfish/src/mining/webApi/mainState.json'
// const allUsersJSON = '/home/iron/Рабочий стол/ironfish_0.1.366/ironfish/ironfish/src/mining/webApi/allUsers.json'
const transactionJSON = '/home/iron/Рабочий стол/ironfish_0.1.366/ironfish/ironfish/src/mining/webApi/transactiom.json'
// const userCoinsJSON = '/home/iron/Рабочий стол/ironfish_0.1.366/ironfish/ironfish/src/mining/webApi/paidCoins.json'
// const sharesJSON = '/home/iron/Рабочий стол/ironfish_0.1.366/ironfish/ironfish/src/mining/webApi/shares.json'
// const allPayoutJSON = '/home/iron/Рабочий стол/ironfish_0.1.366/ironfish/ironfish/src/mining/webApi/allPayout.json'

export default class webApi {
    currentRequetId: number

    readonly pool: MiningPool
    readonly config: Config
    readonly rpc: IronfishRpcClient
    readonly StratumServer: StratumServer
    readonly hashRate: Meter

    readonly host?: string
    readonly port?: number

    userInfo: any
    hash: any
    blockInfo: any = []
    avarageHashRateFifteenMinutes: Array<{hash: number, timestamp: {}}>
    avarageHashRateDay: Array<{hash: number, timestamp: string}>

    constructor(options: {
        pool: MiningPool,
        config: Config,
        rpc: IronfishRpcClient,
        StratumServer: StratumServer,
        hashRate: Meter,
        currentRequetId: number
        host?: string,
        port?: number
    }) {
        this.rpc = options.pool.rpc;
        this.config = options.config;
        this.pool = options.pool;
        this.StratumServer = options.StratumServer;
        this.hashRate = options.hashRate
        this.currentRequetId = options.currentRequetId
        this.avarageHashRateFifteenMinutes = []
        this.avarageHashRateDay = []
    }
    
    async headerState() {
      const currnetMiners = () => {
         return this.StratumServer.myLog()
      }
      
      let fullPay = 0
      let hash = await this.pool.estimateHashRate();
      let luck = await this.pool.lucky() == 15000 ? 0 : await this.pool.lucky();
      let getTheTotalPayoutOfThePool = await this.pool.getTheTotalPayoutOfThePool()            

      let collectingGeneralPayments = () => {
          getTheTotalPayoutOfThePool.forEach((amount) => {
              fullPay = fullPay + amount.amount 
          }) 
      }

      collectingGeneralPayments()

      // Get all the blocks found
      const transactionBlock = await this.pool.getTransaction()
      this.blockInfo = []

      transactionBlock.forEach((block) => {
          this.blockInfo.push(block)
      })

      let json = JSON.stringify({
              counterHashRate: `${FileUtils.formatHashRate(hash)}/s`,
              poolMiners: currnetMiners(),
              luck: parseFloat(String(luck.toFixed(4))),
              blocks: this.blockInfo,
              amountOfUsersMoney: {
                unprocessedAmount: fullPay,
                ironWithAComma: oreToIron(fullPay)
              },
      })

      fs.writeFileSync(mainStateJSON, json)
    };

    mainState() {
        app.get('/api/home', async (req: any, res: any ) => {
            try {
                console.log(await this.pool.totalUsers())
                const mainJSON = fs.readFileSync(mainStateJSON).toString()
                const parseJSON = JSON.parse(mainJSON)
    
                return res.send(parseJSON)
            } catch (e){ 
                res.status(500).send("Fail")
            }
            
        })  
    }

    statePool() {
        app.get('/api/statePool', async (req: any, res: any ) => {
            try {
                let allRate = []

                let gethashRateFifteenMinutes = await this.pool.gethashRateFifteenMinutes()
                
                allRate.push(gethashRateFifteenMinutes)
    
                let json = JSON.stringify({
                    hashRate: allRate
                })
                return res.send(json)
            } catch (e) {
                res.status(500).send("Fail")
            }

        })
    }

    findUser() {
        const urlencodedParser = express.urlencoded({extended: false});

        app.post("/api/finduser", urlencodedParser, async (req: any, res: any) => {
            if(!req.body) return res.sendStatus(400);
            
            try {
                const publicAddress = req.body.publickey

                let amountOfUsersMoney = await this.pool.getAmountUser(publicAddress)   
                let userRateEightHours = await this.pool.getUserHashRateGraphics(publicAddress) 
                let findUser = await this.pool.findUserByPublicAddress(publicAddress)
                let awardsPaid = await this.pool.getTheUserPayout(publicAddress)
                let averageUserEarnings: number | string;
                this.hash = await this.StratumServer.valuesClients(FIND_PUBLICK_ADDRESS, publicAddress)

                // if (this.hash !== 0) {
                    averageUserEarnings = 86400 * 20 * Number(FileUtils.formatHashRateWithoutSuffix(this.hash)) * 1000000 / 22883417649311;
                    
                    String(averageUserEarnings).split('').forEach((val: any, index: number, arr: any) => {
                        if (val === '.') {
                            const segment1 = arr.slice(0, index).join("")
                            const segment2 = arr.slice(index, index + 8).join("")
                            
                            averageUserEarnings = `${segment1}${segment2}`
                        }
                    })
                // } else {
                //     averageUserEarnings = 0
                // }

                const errorNotFoundUser = {
                    status: 200,
                    errorMessage: 'successfully!' 
                }
    
                if ( findUser[0]?.publicAddress === publicAddress ) {
                    this.userInfo = findUser[0]
                    errorNotFoundUser.status = 200
                } else if (findUser[0]?.publicAddress !== publicAddress) {
                    errorNotFoundUser.status = 404
                    errorNotFoundUser.errorMessage = 'Not Found User'
                }

                if ( errorNotFoundUser.status === 404 ) { 
                    let errorJson = JSON.stringify({
                        errorMessage: errorNotFoundUser.errorMessage
                    })
                    
                return res.send(errorJson)
                } else if(errorNotFoundUser.status === 200){
                    let json = JSON.stringify({
                        publicAddress: this.userInfo?.publicAddress ? this.userInfo.publicAddress : 'default',
                        timestamp: this.userInfo?.timestamp,
                        amountOfUsersMoney: {
                            ironWithAComma: oreToIron(amountOfUsersMoney[0]?.amount),
                            unprocessedAmount: amountOfUsersMoney[0]?.amount
                        },
                        online: this.userInfo?.online < 1 ? this.userInfo?.lastMining: 'online',
                        hashRate: FileUtils.formatHashRate(this.hash ? this.hash : 0),
                        userRateEightHours: {
                            rawUserRateEightHours: userRateEightHours,
                        },
                        awardsPaid: awardsPaid,
                        averageUserEarnings: averageUserEarnings
                    })

                    return res.send(json)
                }
            } catch (e) {
                res.status(500).send("Fail")
            }

        });
    }

    async getMainData() {
        // Block
        // const block: any = await this.pool.getAllBlock()
        // const blockJson: any = JSON.stringify(block)
        // console.log('Copy informations about users our pool');


        // Users
        // const users: any = await this.pool.getAllUsers()
        // const usersJson = JSON.stringify(users)
        

        // Paid Coins
        // const paidCoins: any = await this.pool.getPaidCoins()
        // const paidCoinsJSON = JSON.stringify(paidCoins)

        // All Shares
        // const getAllShares = await this.pool.getAllShares()
        // const getAllSharesJson: any = JSON.stringify(getAllShares) 

        // Get All Payout
        // const getAllPayout = await this.pool.getAllPayout()
        // const getAllPayoutJson = JSON.stringify(getAllPayout)
        
        // fs.writeFileSync(allUsersJSON, usersJson)
        // fs.writeFileSync(transactionJSON, blockJson)
        // fs.writeFileSync(userCoinsJSON, paidCoinsJSON)
        // fs.writeFileSync(sharesJSON, getAllSharesJson)
        // fs.writeFileSync(allPayoutJSON, getAllPayoutJson)
    }

    async readJsonWirhAllUsers() {
        let transaction = fs.readFileSync(transactionJSON).toString()

        const convertUsersInJSON = JSON.parse(transaction)
        convertUsersInJSON.forEach((block: any) => {
            this.pool.setAllUsers(block)
        })
    }

    async automaticStatisticsUpdate () {
        setInterval(async() => {
            await this.headerState();
        }, 40000)
    }

    listen() {
        app.listen(port, host, () => {
        	console.log(`Listening to requests on http://${host}:${port}`);
        });
    }

    start() {
        this.listen();
        this.getMainData();
        this.statePool();
        this.findUser();
        this.mainState();
        this.automaticStatisticsUpdate();
    }
}