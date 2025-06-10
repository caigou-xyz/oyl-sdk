import { Provider } from '../provider'
import { Account, AddressKey, SpendStrategy } from '../account'
import asyncPool from 'tiny-async-pool'
import { OrdOutput } from 'rpclient/ord'
import { getAddressKey } from '../shared/utils'
import { Outpoint } from 'rpclient/alkanes'

export interface EsploraUtxo {
  txid: string
  vout: number
  status: {
    confirmed: boolean
    block_height?: number
    block_hash?: string
    block_time?: number
  }
  value: number
}

export interface FormattedUtxo {
  txId: string
  outputIndex: number
  satoshis: number
  scriptPk: string
  address: string
  inscriptions: any[]
  confirmations: number
}

export interface AddressUtxoPortfolio {
  alkaneUtxos: FormattedUtxo[]
  spendableTotalBalance: number
  spendableUtxos: FormattedUtxo[]
  runeUtxos: FormattedUtxo[]
  ordUtxos: FormattedUtxo[]
  pendingUtxos: FormattedUtxo[]
  otherUtxos: FormattedUtxo[]
  pendingTotalBalance: number
  totalBalance: number
}

export interface AccountUtxoPortfolio {
  accountTotalBalance: number
  accountSpendableTotalUtxos: FormattedUtxo[]
  accountSpendableTotalBalance: number
  accountPendingTotalBalance: number
  accounts: Record<AddressKey, AddressUtxoPortfolio>
}

export const accountBalance = async ({
  account,
  provider,
}: {
  account: Account
  provider: Provider
}) => {
  let confirmedAmount: number = 0
  let pendingAmount: number = 0
  let amount: number = 0

  for (let i = 0; i < account.spendStrategy.addressOrder.length; i++) {
    const address = account[account.spendStrategy.addressOrder[i]].address
    const { chain_stats, mempool_stats } = await provider.esplora._call(
      'esplora_address',
      [address]
    )

    const btcBalance = chain_stats.funded_txo_sum - chain_stats.spent_txo_sum
    const pendingBtcBalance =
      mempool_stats.funded_txo_sum - mempool_stats.spent_txo_sum

    confirmedAmount += btcBalance
    pendingAmount += pendingBtcBalance
    amount += btcBalance + pendingAmount
  }
  return {
    confirmedAmount: Math.floor(confirmedAmount / 10 ** 8),
    pendingAmount: Math.floor(pendingAmount / 10 ** 8),
    amount: Math.floor(amount / 10 ** 8),
  }
}

export const addressBalance = async ({
  address,
  provider,
}: {
  address: string
  provider: Provider
}) => {
  let confirmedAmount: number = 0
  let pendingAmount: number = 0
  let amount: number = 0

  const { chain_stats, mempool_stats } = await provider.esplora._call(
    'esplora_address',
    [address]
  )

  const btcBalance = chain_stats.funded_txo_sum - chain_stats.spent_txo_sum
  const pendingBtcBalance =
    mempool_stats.funded_txo_sum - mempool_stats.spent_txo_sum

  confirmedAmount += btcBalance
  pendingAmount += pendingBtcBalance
  amount += btcBalance + pendingAmount

  return {
    confirmedAmount: confirmedAmount / 10 ** 8,
    pendingAmount: pendingAmount / 10 ** 8,
    amount: amount / 10 ** 8,
  }
}

export const addressUtxos = async ({
  address,
  provider,
  spendStrategy,
}: {
  address: string
  provider: Provider
  spendStrategy?: SpendStrategy
}): Promise<AddressUtxoPortfolio> => {
  let spendableTotalBalance: number = 0
  let pendingTotalBalance: number = 0
  let totalBalance: number = 0
  const spendableUtxos: FormattedUtxo[] = []
  const pendingUtxos: FormattedUtxo[] = []
  const ordUtxos: FormattedUtxo[] = []
  const runeUtxos: FormattedUtxo[] = []
  const otherUtxos: FormattedUtxo[] = []
  let alkaneUtxos: FormattedUtxo[] = []
  const multiCall = await provider.multiCall([
    ['esplora_address::utxo', [address]],
    ['btc_getblockcount', []],
  ])

  const blockCount = multiCall[1].result
  let utxos = multiCall[0].result as EsploraUtxo[]

  if (utxos.length === 0) {
    return {
      otherUtxos,
      alkaneUtxos,
      spendableTotalBalance,
      spendableUtxos,
      runeUtxos,
      ordUtxos,
      pendingUtxos,
      pendingTotalBalance,
      totalBalance,
    }
  }

  const concurrencyLimit = 50
  const processedUtxos: {
    utxo: EsploraUtxo
    txOutput: OrdOutput
    scriptPk: string
    alkane?: Outpoint
  }[] = []

  const processUtxo = async (utxo: EsploraUtxo) => {
    try {
      const txIdVout = `${utxo.txid}:${utxo.vout}`

      const multiCall = await provider.multiCall([
        ['ord_output', [txIdVout]],
        ['esplora_tx', [utxo.txid]],
        [
          'alkanes_protorunesbyoutpoint',
          [
            {
              txid: Buffer.from(utxo.txid, 'hex').reverse().toString('hex'),
              vout: utxo.vout,
              protocolTag: '1',
            },
            'latest',
          ],
        ],
      ])

      const txOutput = multiCall[0].result as OrdOutput
      const txDetails = multiCall[1].result
      const alkanesByOutpoint = multiCall[2].result as Outpoint[]

      return {
        utxo,
        txOutput,
        scriptPk: txDetails.vout[utxo.vout].scriptpubkey,
        alkane: alkanesByOutpoint[0],
      }
    } catch (error) {
      console.error(`Error processing UTXO ${utxo.txid}:${utxo.vout}`, error)
      throw error
    }
  }

  for await (const result of asyncPool(concurrencyLimit, utxos, processUtxo)) {
    if (result !== null) {
      processedUtxos.push(result)
    }
  }

  const utxoSortGreatestToLeast = spendStrategy?.utxoSortGreatestToLeast ?? true

  processedUtxos.sort((a, b) =>
    utxoSortGreatestToLeast
      ? b.utxo.value - a.utxo.value
      : a.utxo.value - b.utxo.value
  )

  for (const { utxo, txOutput, scriptPk, alkane } of processedUtxos) {
    totalBalance += utxo.value

    if (txOutput.indexed) {
      const hasInscriptions = txOutput.inscriptions.length > 0
      const hasRunes = Object.keys(txOutput.runes).length > 0
      const hasAlkanes = !!alkane
      const confirmations = blockCount - utxo.status.block_height

      if (!utxo.status.confirmed) {
        pendingUtxos.push({
          txId: utxo.txid,
          outputIndex: utxo.vout,
          satoshis: utxo.value,
          address: address,
          inscriptions: [],
          confirmations: 0,
          scriptPk,
        })
        pendingTotalBalance += utxo.value
        continue
      }

      if (hasAlkanes) {
        alkaneUtxos.push({
          txId: utxo.txid,
          outputIndex: utxo.vout,
          satoshis: utxo.value,
          address: address,
          inscriptions: [],
          confirmations,
          scriptPk,
        })
      }

      if (hasRunes) {
        runeUtxos.push({
          txId: utxo.txid,
          outputIndex: utxo.vout,
          satoshis: utxo.value,
          address: address,
          inscriptions: [],
          confirmations,
          scriptPk,
        })
      }
      if (hasInscriptions) {
        ordUtxos.push({
          txId: utxo.txid,
          outputIndex: utxo.vout,
          satoshis: utxo.value,
          address: address,
          inscriptions: txOutput.inscriptions,
          confirmations,
          scriptPk,
        })
      }
      if (!hasInscriptions && !hasRunes && utxo.value !== 546 && utxo.value !== 330) {
        spendableUtxos.push({
          txId: utxo.txid,
          outputIndex: utxo.vout,
          satoshis: utxo.value,
          address: address,
          inscriptions: [],
          confirmations,
          scriptPk,
        })
        spendableTotalBalance += utxo.value
        continue
      }
      if (!hasInscriptions && !hasRunes) {
        otherUtxos.push({
          txId: utxo.txid,
          outputIndex: utxo.vout,
          satoshis: utxo.value,
          address: address,
          inscriptions: [],
          confirmations,
          scriptPk,
        })
      }
    }
  }

  return {
    alkaneUtxos,
    spendableTotalBalance,
    spendableUtxos,
    runeUtxos,
    ordUtxos,
    pendingUtxos,
    otherUtxos,
    pendingTotalBalance,
    totalBalance,
  }
}

export const accountUtxos = async ({
  account,
  provider,
}: {
  account: Account
  provider: Provider
}): Promise<AccountUtxoPortfolio> => {
  let accountSpendableTotalUtxos = []
  let accountSpendableTotalBalance = 0
  let accountPendingTotalBalance = 0
  let accountTotalBalance = 0
  const accounts = {} as Record<AddressKey, AddressUtxoPortfolio>
  const addresses = [
    { addressKey: 'nativeSegwit', address: account.nativeSegwit.address },
    { addressKey: 'nestedSegwit', address: account.nestedSegwit.address },
    { addressKey: 'taproot', address: account.taproot.address },
    { addressKey: 'legacy', address: account.legacy.address },
  ]
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i].address
    const addressKey = addresses[i].addressKey
    const {
      alkaneUtxos,
      otherUtxos,
      spendableTotalBalance,
      spendableUtxos,
      runeUtxos,
      ordUtxos,
      pendingUtxos,
      pendingTotalBalance,
      totalBalance,
    } = await addressUtxos({
      address,
      provider,
    })

    accountSpendableTotalBalance += spendableTotalBalance
    accountSpendableTotalUtxos.push(...spendableUtxos)
    accountPendingTotalBalance += pendingTotalBalance
    accountTotalBalance += totalBalance

    accounts[addressKey] = {
      alkaneUtxos,
      otherUtxos,
      spendableTotalBalance,
      spendableUtxos,
      runeUtxos,
      ordUtxos,
      pendingUtxos,
      pendingTotalBalance,
      totalBalance,
    }
  }
  return {
    accountTotalBalance,
    accountSpendableTotalUtxos,
    accountSpendableTotalBalance,
    accountPendingTotalBalance,
    accounts,
  }
}

export const selectUtxos = (
  utxos: FormattedUtxo[],
  spendStrategy: SpendStrategy
) => {
  const addressMap = new Map<string, FormattedUtxo[]>()

  utxos.forEach((utxo) => {
    const addressKey = getAddressKey(utxo.address)
    if (spendStrategy.addressOrder.includes(addressKey)) {
      if (!addressMap.has(addressKey)) {
        addressMap.set(addressKey, [])
      }
      addressMap.get(addressKey)!.push(utxo)
    }
  })

  return spendStrategy.addressOrder.flatMap((addressKey) => {
    const utxosForAddress = addressMap.get(addressKey) || []
    return utxosForAddress.sort(
      (a, b) =>
        (spendStrategy.utxoSortGreatestToLeast ? b.satoshis : a.satoshis) -
        (spendStrategy.utxoSortGreatestToLeast ? a.satoshis : b.satoshis)
    )
  })
}
