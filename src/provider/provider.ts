import { SandshrewBitcoinClient } from '../rpclient/sandshrew'
import { EsploraRpc } from '../rpclient/esplora'
import { OrdRpc } from '../rpclient/ord'
import * as bitcoin from 'bitcoinjs-lib'
import { waitForTransaction } from '..'
import { AlkanesRpc } from '../rpclient/alkanes'
import { BlockstreamEsploraClient } from '../rpclient/blockstream-esplora'

export type ProviderConstructorArgs = {
  url: string
  projectId: string
  network: bitcoin.networks.Network
  networkType: 'signet' | 'mainnet' | 'testnet' | 'regtest'
  version?: string
  apiProvider?: any
  fallbackToBlockstream?: boolean
}



export class Provider {
  public sandshrew: SandshrewBitcoinClient
  public esplora: EsploraRpc
  public ord: OrdRpc
  public api: any
  public alkanes: AlkanesRpc
  public blockstreamEsplora?: BlockstreamEsploraClient
  public network: bitcoin.networks.Network
  public networkType: string
  public url: string
  public useBlockstreamFallback: boolean

  constructor({
    url,
    projectId,
    network,
    networkType,
    version = 'v1',
    apiProvider,
    fallbackToBlockstream = false,
  }: ProviderConstructorArgs) {
    let isTestnet: boolean
    let isRegtest: boolean
    switch (network) {
      case bitcoin.networks.testnet:
        isTestnet = true

      case bitcoin.networks.regtest:
        isRegtest = true
    }
    const masterUrl = [url, version, projectId].filter(Boolean).join('/');
    
    this.alkanes = new AlkanesRpc(masterUrl)
    this.sandshrew = new SandshrewBitcoinClient(masterUrl)
    this.esplora = new EsploraRpc(masterUrl)
    this.ord = new OrdRpc(masterUrl)
    this.api = apiProvider
    this.network = network
    this.networkType = networkType
    this.url = masterUrl
    
    // 对 signet 网络强制启用 Blockstream fallback
    this.useBlockstreamFallback = fallbackToBlockstream || networkType === 'signet'
    
    // 如果启用了 fallback 或者是某些网络类型，则初始化 Blockstream Esplora 客户端
    if (this.useBlockstreamFallback || ['signet', 'testnet', 'mainnet'].includes(networkType)) {
      try {
        this.blockstreamEsplora = new BlockstreamEsploraClient(networkType as 'mainnet' | 'testnet' | 'signet')
      } catch (error) {
        console.warn('Failed to initialize Blockstream Esplora client:', error)
      }
    }
  }

  // 添加一个包装方法来处理 multiCall
  async multiCall(calls: Array<[string, any[]]>): Promise<Array<{ result: any }>> {
    // 如果是 signet 或启用了 fallback，优先使用 Blockstream Esplora
    if (this.useBlockstreamFallback && this.blockstreamEsplora) {
      try {
        return await this.blockstreamEsplora.multiCall(calls)
      } catch (error) {
        console.warn('Blockstream Esplora multiCall failed, trying Sandshrew:', error)
      }
    }
    
    try {
      // 尝试使用 Sandshrew
      return await this.sandshrew.multiCall(calls)
    } catch (error) {
      console.warn('Sandshrew multiCall failed:', error)
      
      // 如果 Sandshrew 失败且有 Blockstream 客户端，使用它作为 fallback
      if (this.blockstreamEsplora && !this.useBlockstreamFallback) {
        console.log('Falling back to Blockstream Esplora')
        return await this.blockstreamEsplora.multiCall(calls)
      }
      
      throw error
    }
  }

  async pushPsbt({
    psbtHex,
    psbtBase64,
  }: {
    psbtHex?: string
    psbtBase64?: string
  }) {
    if (!psbtHex && !psbtBase64) {
      throw new Error('Please supply psbt in either base64 or hex format')
    }
    if (psbtHex && psbtBase64) {
      throw new Error('Please select one format of psbt to broadcast')
    }
    let psbt: bitcoin.Psbt
    if (psbtHex) {
      psbt = bitcoin.Psbt.fromHex(psbtHex, {
        network: this.network,
      })
    }

    if (psbtBase64) {
      psbt = bitcoin.Psbt.fromBase64(psbtBase64, {
        network: this.network,
      })
    }

    let extractedTx: bitcoin.Transaction
    try {
      extractedTx = psbt.extractTransaction()
    } catch (error) {
      throw new Error('Transaction could not be extracted do to invalid Psbt.')
    }
    const txId = extractedTx.getId()
    const rawTx = extractedTx.toHex()

    // 如果启用了 Blockstream fallback，尝试使用它
    if (this.useBlockstreamFallback || !this.sandshrew) {
      if (this.blockstreamEsplora) {
        try {
          await this.blockstreamEsplora.pushTx(rawTx)
          
          // 简化的返回值，因为 Blockstream API 不提供所有详细信息
          return {
            txId,
            rawTx,
            size: extractedTx.virtualSize(),
            weight: extractedTx.weight(),
            fee: 0, // 无法从 Blockstream API 直接获取
            satsPerVByte: '0',
          }
        } catch (blockstreamError) {
          console.error('Blockstream Esplora push failed:', blockstreamError)
          throw blockstreamError
        }
      } else {
        throw new Error('No available service to broadcast transaction')
      }
    }

    // 原始的 Sandshrew 逻辑
    const [result] = await this.sandshrew.bitcoindRpc.testMemPoolAccept([rawTx])

    if (!result.allowed) {
      throw new Error(result['reject-reason'])
    }
    await this.sandshrew.bitcoindRpc.sendRawTransaction(rawTx)

    await waitForTransaction({
      txId,
      sandshrewBtcClient: this.sandshrew,
    })

    const txInMemPool = await this.sandshrew.bitcoindRpc.getMemPoolEntry(txId)
    const fee = txInMemPool.fees['base'] * 10 ** 8

    return {
      txId,
      rawTx,
      size: txInMemPool.vsize,
      weight: txInMemPool.weight,
      fee: fee,
      satsPerVByte: (fee / (txInMemPool.weight / 4)).toFixed(2),
    }
  }
}
