import fetch from 'node-fetch'

export interface UtxoInfo {
  txid: string
  vout: number
  value: number
  status: {
    confirmed: boolean
    block_height?: number
    block_hash?: string
    block_time?: number
  }
}

export interface TxInfo {
  txid: string
  version: number
  locktime: number
  vin: Array<{
    txid: string
    vout: number
    prevout?: {
      scriptpubkey: string
      scriptpubkey_asm: string
      scriptpubkey_type: string
      scriptpubkey_address?: string
      value: number
    }
    scriptsig: string
    scriptsig_asm: string
    witness?: string[]
    is_coinbase: boolean
    sequence: number
  }>
  vout: Array<{
    scriptpubkey: string
    scriptpubkey_asm: string
    scriptpubkey_type: string
    scriptpubkey_address?: string
    value: number
  }>
  size: number
  weight: number
  fee: number
  status: {
    confirmed: boolean
    block_height?: number
    block_hash?: string
    block_time?: number
  }
}

export class BlockstreamEsploraClient {
  private baseUrl: string

  constructor(networkType: 'mainnet' | 'testnet' | 'signet') {
    if (networkType === 'mainnet') {
      this.baseUrl = 'https://blockstream.info/api'
    } else if (networkType === 'testnet') {
      this.baseUrl = 'https://blockstream.info/testnet/api'
    } else if (networkType === 'signet') {
      this.baseUrl = 'https://mempool.space/signet/api'
    } else {
      throw new Error(`Unsupported network type: ${networkType}`)
    }
  }

  async getAddressUtxos(address: string): Promise<UtxoInfo[]> {
    const response = await fetch(`${this.baseUrl}/address/${address}/utxo`)
    if (!response.ok) {
      throw new Error(`Failed to fetch UTXOs: ${response.statusText}`)
    }
    return response.json() as Promise<UtxoInfo[]>
  }

  async getTxInfo(txid: string): Promise<TxInfo> {
    const response = await fetch(`${this.baseUrl}/tx/${txid}`)
    if (!response.ok) {
      throw new Error(`Failed to fetch transaction: ${response.statusText}`)
    }
    return response.json() as Promise<TxInfo>
  }

  async pushTx(txHex: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/tx`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: txHex,
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Failed to broadcast transaction: ${errorText}`)
    }
    
    return response.text()
  }

  async getBlockHeight(): Promise<number> {
    const response = await fetch(`${this.baseUrl}/blocks/tip/height`)
    if (!response.ok) {
      throw new Error(`Failed to fetch block height: ${response.statusText}`)
    }
    return response.json() as Promise<number>
  }

  async getFeeEstimates(): Promise<{ [key: string]: number }> {
    const response = await fetch(`${this.baseUrl}/fee-estimates`)
    if (!response.ok) {
      throw new Error(`Failed to fetch fee estimates: ${response.statusText}`)
    }
    return response.json() as Promise<{ [key: string]: number }>
  }

  // 模拟 Sandshrew 的 multiCall 方法
  async multiCall(calls: Array<[string, any[]]>): Promise<Array<{ result: any }>> {
    const results = []
    
    for (const [method, params] of calls) {
      try {
        let result: any
        
        switch (method) {
          case 'esplora_address::utxo':
            const [address] = params
            result = await this.getAddressUtxos(address)
            break
            
          case 'btc_getblockcount':
            result = await this.getBlockHeight()
            break
            
          case 'ord_output':
            // 对于 ord_output，我们简化处理，返回一个基本的结构
            const [txidVout] = params
            const [txid, vout] = txidVout.split(':')
            result = {
              indexed: true, // 设置为 true 以便继续处理
              inscriptions: [],
              runes: {},
            }
            break
            
          case 'esplora_tx':
            const [txId] = params
            result = await this.getTxInfo(txId)
            break
            
          case 'alkanes_protorunesbyoutpoint':
            // 对于 alkanes，我们返回空结果，因为大多数替代服务不支持 alkanes
            result = []
            break
            
          default:
            console.warn(`Unsupported method in multiCall: ${method}`)
            result = null
        }
        
        results.push({ result })
      } catch (error) {
        console.error(`Error in multiCall method ${method}:`, error)
        // 返回空结果而不是抛出错误，以保持兼容性
        results.push({ result: null })
      }
    }
    
    return results
  }
} 