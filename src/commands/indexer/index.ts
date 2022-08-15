import axios from 'axios'
import {AxiosResponse} from 'axios'

import {CliUx, Command, Flags} from '@oclif/core'
import {ethers} from 'ethers'

import {ensureConfigFileIsValid} from '../../utils/config'

import {decodeDeploymentConfig, decodeDeploymentConfigInput, capitalize, sleep} from '../../utils/utils'
import {networkFlag, warpFlag, FilterType, OperatorMode, BlockJob, NetworkMonitor} from '../../utils/network-monitor'
import {startHealthcheckServer} from '../../utils/health-check-server'

import dotenv from 'dotenv'
dotenv.config()

type DBJob = {
  timestamp: number
  network: string
  query: string
  message: string
  callback: (res: AxiosResponse) => Promise<void>
}

type DBJobMap = {
  [key: number]: DBJob[]
}

type PatchOptions = {
  res: AxiosResponse<any>
  network: string
  query: string
  data: any
  messages: string[]
}

export default class Indexer extends Command {
  static LAST_BLOCKS_FILE_NAME = 'indexer-blocks.json'
  static description = 'Listen for EVM events and update database network status'
  static examples = ['$ holo indexer --networks="rinkeby mumbai fuji" --mode=auto']
  static flags = {
    mode: Flags.string({
      description: 'The mode in which to run the indexer',
      options: ['listen', 'manual', 'auto'],
      char: 'm',
    }),
    host: Flags.string({description: 'The host to listen on', char: 'h', default: 'http://localhost:9001'}),
    healthCheck: Flags.boolean({
      description: 'Launch server on http://localhost:6000 to make sure command is still running',
      default: false,
    }),
    ...networkFlag,
    ...warpFlag,
  }

  /**
   * Indexer class variables
   */
  // API Params
  baseUrl!: string
  JWT!: string
  DELAY = 20_000

  operatorMode: OperatorMode = OperatorMode.listen

  networkMonitor!: NetworkMonitor
  dbJobMap: DBJobMap = {}

  numericSort(a: number, b: number): number {
    return a - b;
  }

  numberfy(arr: string[]): number[] {
    return arr.map((element: string): number => {
      return Number.parseInt(element, 10)
    })
  }

  async run(): Promise<void> {
    this.log(`Operator command has begun!!!`)
    const {flags} = await this.parse(Indexer)
    this.baseUrl = flags.host
    const enableHealthCheckServer = flags.healthCheck

    this.log(`API: Authenticating with ${this.baseUrl}`)
    let res
    try {
      res = await axios.post(`${this.baseUrl}/v1/auth/operator`, {
        hash: process.env.OPERATOR_API_KEY,
      })
      this.debug(JSON.stringify(res.data))
    } catch (error: any) {
      this.error(error.message)
    }

    this.JWT = res!.data.accessToken

    if (typeof this.JWT === 'undefined') {
      this.error('Failed to authorize as an operator')
    }

    this.debug(`process.env.OPERATOR_API_KEY = ${process.env.OPERATOR_API_KEY}`)
    this.debug(`this.JWT = ${this.JWT}`)

    // Indexer always runs in listen mode
    this.log(`Indexer mode: ${this.operatorMode}`)

    this.log('Loading user configurations...')
    const {configFile} = await ensureConfigFileIsValid(this.config.configDir, undefined, false)
    this.log('User configurations loaded.')

    this.networkMonitor = new NetworkMonitor({
      parent: this,
      configFile,
      networks: flags.networks,
      debug: this.debug,
      processTransactions: this.processTransactions,
      lastBlockFilename: 'indexer-blocks.json',
      warp: flags.warp,
    })

    // Indexer always synchronizes missed blocks
    this.networkMonitor.latestBlockHeight = await this.networkMonitor.loadLastBlocks(this.config.configDir)

    CliUx.ux.action.start(`Starting indexer in mode: ${OperatorMode[this.operatorMode]}`)
    await this.networkMonitor.run(!(flags.warp > 0), undefined, this.filterBuilder)
    CliUx.ux.action.stop('🚀')

    // Start server
    if (enableHealthCheckServer) {
      startHealthcheckServer()
    }

    this.processDBJobs()
  }

  async filterBuilder(): Promise<void> {
    this.networkMonitor.filters = [
      {
        type: FilterType.from,
        match: this.networkMonitor.LAYERZERO_RECEIVERS,
        networkDependant: true,
      },
      {
        type: FilterType.to,
        match: this.networkMonitor.bridgeAddress,
        networkDependant: false,
      },
      {
        type: FilterType.to,
        match: this.networkMonitor.factoryAddress,
        networkDependant: false,
      },
      {
        type: FilterType.to,
        match: this.networkMonitor.operatorAddress,
        networkDependant: false,
      },
    ]
    Promise.resolve()
  }

  async processDBJob(timestamp: number, job: DBJob): Promise<void> {
    this.networkMonitor.structuredLog(job.network, job.message)
    let res: any
    try {
      res = await axios.get(job.query, {
        headers: {
          Authorization: `Bearer ${this.JWT}`,
          'Content-Type': 'application/json',
        },
      })
      this.networkMonitor.structuredLog(job.network, `GET response ${JSON.stringify(res.data)}`)
      await job.callback.bind(this)(res)
      this.processDBJobs()
    } catch (error: any) {
      this.networkMonitor.structuredLogError(job.network, error, `Failed to GET ${job.query}`)
      // one second interval
      await sleep(1000)
      this.processDBJobs(timestamp, job)
    }
  }

  processDBJobs(timestamp?: number, job?: DBJob): void {
    if (timestamp !== undefined && job !== undefined) {
      this.dbJobMap[timestamp].unshift(job)
    }

    const timestamps: number[] = this.numberfy(Object.keys(this.dbJobMap))
    if (timestamps.length > 0) {
      timestamps.sort(this.numericSort)
      const timestamp: number = timestamps[0]
      if (this.dbJobMap[timestamp].length > 0) {
        const job: DBJob = this.dbJobMap[timestamp].shift()!
        this.processDBJob(timestamp, job)
      } else {
        delete this.dbJobMap[timestamp]
        setInterval(this.processDBJobs.bind(this), 100)
      }
    } else {
      setInterval(this.processDBJobs.bind(this), 100)
    }
  }

  async processTransactions(job: BlockJob, transactions: ethers.providers.TransactionResponse[]): Promise<void> {
    /* eslint-disable no-await-in-loop */
    if (transactions.length > 0) {
      for (const transaction of transactions) {
        this.networkMonitor.structuredLog(
          job.network,
          `Processing transaction ${transaction.hash} at block ${transaction.blockNumber}`,
        )
        const to: string | undefined = transaction.to?.toLowerCase()
        const from: string | undefined = transaction.from?.toLowerCase()
        switch (to) {
          case this.networkMonitor.factoryAddress: {
            await this.handleContractDeployedEvent(transaction, job.network)

            break
          }

          case this.networkMonitor.bridgeAddress: {
            await this.handleBridgeOutEvent(transaction, job.network)

            break
          }

          case this.networkMonitor.operatorAddress: {
            await this.handleBridgeInEvent(transaction, job.network)

            break
          }

          default:
            if (from === this.networkMonitor.LAYERZERO_RECEIVERS[job.network]) {
              await this.handleAvailableOperatorJobEvent(transaction, job.network)
            } else {
              this.networkMonitor.structuredLog(
                job.network,
                `Function processTransactions stumbled on an unknown transaction ${transaction.hash}`,
              )
            }
        }
      }
    }
  }

  async handleContractDeployedEvent(transaction: ethers.providers.TransactionResponse, network: string): Promise<void> {
    const receipt = await this.networkMonitor.providers[network].getTransactionReceipt(transaction.hash)
    if (receipt === null) {
      throw new Error(`Could not get receipt for ${transaction.hash}`)
    }

    if (receipt.status === 1) {
      this.networkMonitor.structuredLog(
        network,
        `Checking if a new Holograph contract was deployed at tx: ${transaction.hash}`,
      )
      const deploymentInfo = this.networkMonitor.decodeBridgeableContractDeployedEvent(receipt)
      if (deploymentInfo !== undefined) {
        await this.updateContractDB(transaction, network, deploymentInfo as any[])
      }
    }
  }

  async handleBridgeOutEvent(transaction: ethers.providers.TransactionResponse, network: string): Promise<void> {
    const receipt = await this.networkMonitor.providers[network].getTransactionReceipt(transaction.hash)
    if (receipt === null) {
      throw new Error(`Could not get receipt for ${transaction.hash}`)
    }

    if (receipt.status === 1) {
      this.networkMonitor.structuredLog(network, `Checking if a bridge request was made at tx: ${transaction.hash}`)
      const operatorJobPayload = this.networkMonitor.decodePacketEvent(receipt)
      const operatorJobHash = operatorJobPayload === undefined ? undefined : ethers.utils.keccak256(operatorJobPayload)
      if (operatorJobHash === undefined) {
        this.networkMonitor.structuredLog(network, `Could not extract cross-chain packet for ${transaction.hash}`)
      } else {
        const bridgeTransaction: ethers.utils.TransactionDescription =
          this.networkMonitor.bridgeContract.interface.parseTransaction(transaction)
        switch (bridgeTransaction.name) {
          case 'deployOut':
            // cross-chain contract deployment
            break
          case 'erc20out':
            // erc20 token being bridged out
            break
          case 'erc721out':
            // erc721 token being bridged out
            break
          default:
            // we have no idea what is going on
            break
        }

        this.networkMonitor.structuredLog(
          network,
          `Bridge-Out trasaction type: ${bridgeTransaction.name} -->> ${bridgeTransaction.args}`,
        )
      }
    }
  }

  async handleBridgeInEvent(transaction: ethers.providers.TransactionResponse, network: string): Promise<void> {
    const parsedTransaction: ethers.utils.TransactionDescription =
      this.networkMonitor.operatorContract.interface.parseTransaction(transaction)
    let bridgeTransaction: ethers.utils.TransactionDescription
    let operatorJobPayload: string
    let operatorJobHash: string
    let receipt: ethers.ContractReceipt
    let deploymentInfo: any[] | undefined
    let transferInfo: any[] | undefined
    switch (parsedTransaction.name) {
      case 'executeJob':
        receipt = await this.networkMonitor.providers[network].getTransactionReceipt(transaction.hash)
        if (receipt === null) {
          throw new Error(`Could not get receipt for ${transaction.hash}`)
        }

        if (receipt.status === 1) {
          this.networkMonitor.structuredLog(
            network,
            `Bridge-In event captured: ${parsedTransaction.name} -->> ${parsedTransaction.args}`,
          )
          operatorJobPayload = parsedTransaction.args._payload
          operatorJobHash = ethers.utils.keccak256(operatorJobPayload)
          this.networkMonitor.structuredLog(network, `Bridge-In transaction is for jobHash ${operatorJobHash}`)
          bridgeTransaction = this.networkMonitor.bridgeContract.interface.parseTransaction({
            data: operatorJobPayload,
            value: ethers.BigNumber.from('0'),
          })
          switch (bridgeTransaction.name) {
            case 'deployIn':
              deploymentInfo = this.networkMonitor.decodeBridgeableContractDeployedEvent(receipt)
              if (deploymentInfo !== undefined) {
                await this.updateContractBridgeDB(transaction, network, deploymentInfo as any[])
              }

              // cross-chain contract deployment completed
              break
            case 'erc20in':
              // erc20 token being bridged in
              break
            case 'erc721in':
              // erc721 token being bridged in
              transferInfo = this.networkMonitor.decodeTransferEvent(receipt)
              if (transferInfo !== undefined) {
                await this.updateNFTBridgeDB(transaction, network, transferInfo as any[])
              }

              break
            default:
              // we have no idea what is going on
              break
          }

          this.networkMonitor.structuredLog(
            network,
            `Bridge-In trasaction type: ${bridgeTransaction.name} -->> ${bridgeTransaction.args}`,
          )
        }

        break
      default:
        this.networkMonitor.structuredLog(network, `Unknown Bridge function executed in tx: ${transaction.hash}`)
        break
    }
  }

  async handleAvailableOperatorJobEvent(
    transaction: ethers.providers.TransactionResponse,
    network: string,
  ): Promise<void> {
    const receipt = await this.networkMonitor.providers[network].getTransactionReceipt(transaction.hash)
    if (receipt === null) {
      throw new Error(`Could not get receipt for ${transaction.hash}`)
    }

    if (receipt.status === 1) {
      this.networkMonitor.structuredLog(
        network,
        `Checking if Operator was sent a bridge job via the LayerZero Relayer at tx: ${transaction.hash}`,
      )
      const operatorJobPayload = this.networkMonitor.decodeAvailableJobEvent(receipt)
      const operatorJobHash = operatorJobPayload === undefined ? undefined : ethers.utils.keccak256(operatorJobPayload)
      if (operatorJobHash === undefined) {
        this.networkMonitor.structuredLog(network, `Could not extract relayer available job for ${transaction.hash}`)
      } else {
        this.networkMonitor.structuredLog(
          network,
          `HolographOperator received a new bridge job on ${capitalize(
            network,
          )}\nThe job payload hash is ${operatorJobHash}\nThe job payload is ${operatorJobPayload}\n`,
        )
      }
    }
  }

  async updateContractDB(
    transaction: ethers.providers.TransactionResponse,
    network: string,
    deploymentInfo: any[],
  ): Promise<void> {
    const config = decodeDeploymentConfigInput(transaction.data)
    const deploymentAddress = deploymentInfo[0] as string
    this.networkMonitor.structuredLog(
      network,
      `\nHolographFactory deployed a new collection on ${capitalize(network)} at address ${deploymentAddress}\n` +
        `Wallet that deployed the collection is ${transaction.from}\n` +
        `The config used for deployHolographableContract was ${JSON.stringify(config, null, 2)}\n` +
        `The transaction hash is: ${transaction.hash}\n`,
    )
    this.networkMonitor.structuredLog(network, 'Sending it to DBJobManager')

    const callback = (transaction: ethers.providers.TransactionResponse, network: string, deploymentAddress: string): (res: AxiosResponse<any>) => Promise<void> => {
      return async (res: AxiosResponse<any>): Promise<void> => {
        const data = JSON.stringify({
          chainId: transaction.chainId,
          status: 'DEPLOYED',
          salt: '0x',
          tx: transaction.hash,
        })
        this.networkMonitor.structuredLog(network, `Successfully found Collection with address ${deploymentAddress}`)
        this.networkMonitor.structuredLog(
          network,
          `API: Requesting to update Collection ${deploymentAddress} with id ${res?.data.id}`,
        )
        await this.makeDBPatch({
          res,
          network,
          query: `${this.baseUrl}/v1/collections/${res?.data.id}`,
          data,
          messages: [
            `PATCH response for collection ${deploymentAddress}`,
            `Successfully updated collection ${deploymentAddress} chainId to ${transaction.chainId}`,
            `Failed to update the Holograph database ${deploymentAddress}`,
            deploymentAddress
          ]
        })
        Promise.resolve()
      }
    }

    const job: DBJob = {
      network,
      timestamp: transaction.timestamp!,
      message: `API: Requesting to get Collection with address ${deploymentAddress}`,
      query: `${this.baseUrl}/v1/collections/contract/${deploymentAddress}`,
      callback: callback.bind(this)(transaction, network, deploymentAddress)
    }
    if (!(job.timestamp in this.dbJobMap)) {
      this.dbJobMap[job.timestamp] = []
    }

    this.dbJobMap[job.timestamp].push(job)
  }

  async updateContractBridgeDB(
    transaction: ethers.providers.TransactionResponse,
    network: string,
    deploymentInfo: any[],
  ): Promise<void> {
    const config = decodeDeploymentConfig(transaction.data)
    const deploymentAddress = deploymentInfo[0] as string
    this.networkMonitor.structuredLog(
      network,
      '\nHolographOperator executed a job which bridged a collection\n' +
        `HolographFactory deployed a new collection on ${capitalize(network)} at address ${deploymentAddress}\n` +
        `Operator that deployed the collection is ${transaction.from}` +
        `The config used for deployHolographableContract function was ${JSON.stringify(config, null, 2)}\n`,
    )
    this.networkMonitor.structuredLog(network, 'Sending it to DBJobManager')

    const callback = (transaction: ethers.providers.TransactionResponse, network: string, deploymentAddress: string): (res: AxiosResponse<any>) => Promise<void> => {
      return async (res: AxiosResponse<any>): Promise<void> => {
        const data = JSON.stringify({
          chainId: transaction.chainId,
          status: 'DEPLOYED',
          salt: '0x',
          tx: transaction.hash,
        })
        this.networkMonitor.structuredLog(network, `Successfully found Collection with address ${deploymentAddress}`)
        this.networkMonitor.structuredLog(
          network,
          `API: Requesting to update Collection ${deploymentAddress} with id ${res?.data.id}`,
        )

        await this.makeDBPatch({
          res,
          network,
          query: `${this.baseUrl}/v1/collections/${res?.data.id}`,
          data,
          messages: [
            `PATCH response for collection ${deploymentAddress}`,
            `Successfully updated collection ${deploymentAddress} chainId to ${transaction.chainId}`,
            `Failed to update the Holograph database ${deploymentAddress}`,
            deploymentAddress
          ]
        })
        Promise.resolve()
      }
    }

    const job: DBJob = {
      network,
      timestamp: transaction.timestamp!,
      query: `${this.baseUrl}/v1/collections/contract/${deploymentAddress}`,
      message: `API: Requesting to get Collection with address ${deploymentAddress}`,
      callback: callback.bind(this)(transaction, network, deploymentAddress)
    }
    if (!(job.timestamp in this.dbJobMap)) {
      this.dbJobMap[job.timestamp] = []
    }

    this.dbJobMap[job.timestamp].push(job)
  }

  async updateNFTBridgeDB(
    transaction: ethers.providers.TransactionResponse,
    network: string,
    transferInfo: any[],
  ): Promise<void> {
    const tokenId = (transferInfo[2] as ethers.BigNumber).toString()
    const contractAddress = transferInfo[3] as string

    this.networkMonitor.structuredLog(
      network,
      '\nHolographOperator executed a job which minted an ERC721 NFT\n' +
        `Holographer minted a new NFT on ${capitalize(network)} at address ${contractAddress}\n` +
        `The ID of the NFT is ${tokenId}\n` +
        `Operator that minted the nft is ${transaction.from}\n`
    )
    this.networkMonitor.structuredLog(network, 'Sending it to DBJobManager')

    const callback = (transaction: ethers.providers.TransactionResponse, network: string, contractAddress: string, tokenId: string): (res: AxiosResponse<any>) => Promise<void> => {
      return async (res: AxiosResponse<any>): Promise<void> => {
        const data = JSON.stringify({
          chainId: transaction.chainId,
          status: 'MINTED',
          tx: transaction.hash,
        })
        this.networkMonitor.structuredLog(network, `Successfully found NFT with tokenId ${tokenId} from ${contractAddress}`)
        // Only update the database if this transaction happened in a later block than the last block we indexed
        // NOTE: This should only be necessary for NFTs because they can only exist on one network at a time so we don't
        //       want to update change update the database to the wrong network while the warp cron is running
        //       if a more recent bridge event happened on chain that moved the NFT to a different network
        if (transaction.blockNumber! > res?.data?.transaction[0]) {
          this.networkMonitor.structuredLog(
            network,
            `Latest transaction in the database is more recent than this transaction. Skipping update for collection ${contractAddress} and tokeId ${tokenId}`,
          )
          return
        }

        this.networkMonitor.structuredLog(
          network,
          `API: Requesting to update NFT with collection ${contractAddress} and tokeId ${tokenId} and id ${res?.data.id}`,
        )

        await this.makeDBPatch({
          res,
          network,
          query: `${this.baseUrl}/v1/nfts/${res?.data.id}`,
          data,
          messages: [
            `PATCH collection ${contractAddress} tokeId ${tokenId}`,
            `Successfully updated NFT collection ${contractAddress} and tokeId ${tokenId}`,
            `Failed to update the database for collection ${contractAddress} and tokeId ${tokenId}`,
            `collection ${contractAddress} and tokeId ${tokenId}`
          ]
        })
        Promise.resolve()
      }
    }

    const job: DBJob = {
      network,
      timestamp: transaction.timestamp!,
      query: `${this.baseUrl}/v1/nfts/${contractAddress}/${tokenId}`,
      message: `API: Requesting to get NFT with tokenId ${tokenId} from ${contractAddress}`,
      callback: callback.bind(this)(transaction, network, contractAddress, tokenId)
    }
    if (!(job.timestamp in this.dbJobMap)) {
      this.dbJobMap[job.timestamp] = []
    }

    this.dbJobMap[job.timestamp].push(job)
  }

  async makeDBPatch(options: PatchOptions): Promise<void> {
    const res = options.res
    const network = options.network
    const query = options.query
    const data = options.data
    const messages = options.messages
    const params = {
      headers: {
        Authorization: `Bearer ${this.JWT}`,
        'Content-Type': 'application/json',
      },
      data: data,
    }
    try {
      const patchRes = await axios.patch(query, data, params)
      this.networkMonitor.structuredLog(
        network,
        `${messages[0]} and id ${res?.data.id} response ${JSON.stringify(
          patchRes.data,
        )}`,
      )
      this.networkMonitor.structuredLog(network, messages[1])
    } catch (error: any) {
      this.networkMonitor.structuredLog(network, messages[2])
      this.networkMonitor.structuredLogError(network, error, messages[3])
    }
  }
}
