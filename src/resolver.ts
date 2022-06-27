/* eslint-disable @typescript-eslint/no-var-requires */
import { Base58 } from '@ethersproject/basex'
import { BigNumber } from '@ethersproject/bignumber'
import { Block, BlockTag } from '@ethersproject/providers'
// import { ConfigurationOptions, ConfiguredNetworks, configureResolverWithNetworks } from './configuration'
import { CallType, ContractInfo, VeridaSelfTransactionConfig, VeridaMetaTransactionConfig } from '@verida/web3'
import { VeridaContractInstance, VeridaContract } from '@verida/web3'

import {
  DIDDocument,
  DIDResolutionOptions,
  DIDResolutionResult,
  DIDResolver,
  ParsedDID,
  Resolvable,
  ServiceEndpoint,
  VerificationMethod,
} from 'did-resolver'
import {
  interpretIdentifier,
  DIDAttributeChanged,
  DIDDelegateChanged,
  ERC1056Event,
  eventNames,
  legacyAlgoMap,
  legacyAttrTypes,
  LegacyVerificationMethod,
  verificationMethodTypes,
  identifierMatcher,
  nullAddress,
  DIDOwnerChanged,
  Errors,
  strip0x,
} from './helpers'
import { logDecoder } from './logParser'

const Web3 = require('web3')
const Web3HttpProvider = require('web3-providers-http')

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config()

// Read contract info from env
const abi = require('./contract/abi.json')
const currentNet = process.env.RPC_TARGET_NET != undefined ? process.env.RPC_TARGET_NET : 'RPC_URL_POLYGON_MAINNET'
const address = process.env[`CONTRACT_ADDRESS_${currentNet}_DidRegistry`]
if (!address) {
  throw new Error('Contract address not defined in env')
}
const contractInfo: ContractInfo = {
  abi: abi,
  address: address!,
}

const rpcURL = eval(`process.env.${currentNet}`)
const web3 = new Web3(rpcURL)
const web3Provider = new Web3HttpProvider(rpcURL)
const contract = new web3.eth.Contract(abi, address)

type Configuration = VeridaMetaTransactionConfig | VeridaSelfTransactionConfig

export function getResolver(type: CallType, options: Configuration): Record<string, DIDResolver> {
  return new VdaDidResolver(type, options).build()
}

export class VdaDidResolver {
  private type: CallType
  private options: Configuration

  private didContract: VeridaContract

  constructor(type: CallType, options: Configuration) {
    this.type = type
    this.options = options

    this.didContract = VeridaContractInstance(type, {
      ...contractInfo,
      ...options,
    })
  }

  /**
   * returns the current owner of a DID (represented by an address or public key)
   *
   * @param address
   */
  async getOwner(address: string): Promise<string> {
    //TODO: check if address or public key
    return this.didContract.identityOwner(address)
  }

  /**
   * returns the previous change
   *
   * @param address
   */
  async previousChange(address: string): Promise<BigNumber> {
    // const result = await this.contracts[networkId].functions.changed(address, { blockTag })
    const result = await this.didContract.changed(address)

    // console.log(`last change result: '${BigNumber.from(result['0'])}'`)
    return BigNumber.from(result['0'])
  }

  async getBlockMetadata(blockHeight: number): Promise<{ height: string; isoDate: string }> {
    // const block: Block = await this.contracts[networkId].provider.getBlock(blockHeight)
    const block: Block = await web3Provider.getBlock(blockHeight)

    return {
      height: block.number.toString(),
      isoDate: new Date(block.timestamp * 1000).toISOString().replace('.000', ''),
    }
  }

  async changeLog(
    identity: string,
    blockTag: BlockTag = 'latest'
  ): Promise<{ address: string; history: ERC1056Event[]; controllerKey?: string; chainId: number }> {
    const provider = web3Provider
    const chainId = await provider.getNetwork().chainId

    const history: ERC1056Event[] = []
    const { address, publicKey } = interpretIdentifier(identity)
    const controllerKey = publicKey
    let previousChange: BigNumber | null = await this.previousChange(address)
    while (previousChange) {
      const blockNumber = previousChange
      // console.log(`gigel ${previousChange}`)
      const fromBlock =
        previousChange.toHexString() !== '0x00' ? previousChange.sub(1).toHexString() : previousChange.toHexString()
      const logs = await provider.getLogs({
        address: address, // networks[networkId].registryAddress,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        topics: [null as any, `0x000000000000000000000000${address.slice(2)}`],
        fromBlock,
        toBlock: previousChange.toHexString(),
      })
      const events: ERC1056Event[] = logDecoder(contract, logs)
      events.reverse()
      previousChange = null
      for (const event of events) {
        history.unshift(event)
        if (event.previousChange.lt(blockNumber)) {
          previousChange = event.previousChange
        }
      }
    }
    return { address, history, controllerKey, chainId }
  }

  wrapDidDocument(
    did: string,
    address: string,
    controllerKey: string | undefined,
    history: ERC1056Event[],
    chainId: number,
    blockHeight: string | number,
    now: BigNumber
  ): { didDocument: DIDDocument; deactivated: boolean; versionId: number; nextVersionId: number } {
    const baseDIDDocument: DIDDocument = {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://identity.foundation/EcdsaSecp256k1RecoverySignature2020/lds-ecdsa-secp256k1-recovery2020-0.0.jsonld',
      ],
      id: did,
      verificationMethod: [],
      authentication: [],
      assertionMethod: [],
    }

    let controller = address

    const authentication = [`${did}#controller`]
    const keyAgreement: string[] = []

    let versionId = 0
    let nextVersionId = Number.POSITIVE_INFINITY
    let deactivated = false
    let delegateCount = 0
    let serviceCount = 0
    const auth: Record<string, string> = {}
    const keyAgreementRefs: Record<string, string> = {}
    const pks: Record<string, VerificationMethod> = {}
    const services: Record<string, ServiceEndpoint> = {}
    for (const event of history) {
      if (blockHeight !== -1 && event.blockNumber > blockHeight) {
        if (nextVersionId > event.blockNumber) {
          nextVersionId = event.blockNumber
        }
        continue
      } else {
        if (versionId < event.blockNumber) {
          versionId = event.blockNumber
        }
      }
      const validTo = event.validTo || BigNumber.from(0)
      const eventIndex = `${event._eventName}-${
        (<DIDDelegateChanged>event).delegateType || (<DIDAttributeChanged>event).name
      }-${(<DIDDelegateChanged>event).delegate || (<DIDAttributeChanged>event).value}`
      if (validTo && validTo.gte(now)) {
        if (event._eventName === eventNames.DIDDelegateChanged) {
          const currentEvent = <DIDDelegateChanged>event
          delegateCount++
          const delegateType = currentEvent.delegateType //conversion from bytes32 is done in logParser
          switch (delegateType) {
            case 'sigAuth':
              auth[eventIndex] = `${did}#delegate-${delegateCount}`
            // eslint-disable-line no-fallthrough
            case 'veriKey':
              pks[eventIndex] = {
                id: `${did}#delegate-${delegateCount}`,
                type: verificationMethodTypes.EcdsaSecp256k1RecoveryMethod2020,
                controller: did,
                blockchainAccountId: `${currentEvent.delegate}@eip155:${chainId}`,
              }
              break
          }
        } else if (event._eventName === eventNames.DIDAttributeChanged) {
          const currentEvent = <DIDAttributeChanged>event
          const name = currentEvent.name //conversion from bytes32 is done in logParser
          const match = name.match(/^did\/(pub|svc)\/(\w+)(\/(\w+))?(\/(\w+))?$/)
          if (match) {
            const section = match[1]
            const algorithm = match[2]
            const type = legacyAttrTypes[match[4]] || match[4]
            const encoding = match[6]
            switch (section) {
              case 'pub': {
                delegateCount++
                const pk: LegacyVerificationMethod = {
                  id: `${did}#delegate-${delegateCount}`,
                  type: `${algorithm}${type}`,
                  controller: did,
                }
                pk.type = legacyAlgoMap[pk.type] || algorithm
                switch (encoding) {
                  case null:
                  case undefined:
                  case 'hex':
                    pk.publicKeyHex = strip0x(currentEvent.value)
                    break
                  case 'base64':
                    pk.publicKeyBase64 = Buffer.from(currentEvent.value.slice(2), 'hex').toString('base64')
                    break
                  case 'base58':
                    pk.publicKeyBase58 = Base58.encode(Buffer.from(currentEvent.value.slice(2), 'hex'))
                    break
                  case 'pem':
                    pk.publicKeyPem = Buffer.from(currentEvent.value.slice(2), 'hex').toString()
                    break
                  default:
                    pk.value = strip0x(currentEvent.value)
                }
                pks[eventIndex] = pk
                if (match[4] === 'sigAuth') {
                  auth[eventIndex] = pk.id
                } else if (match[4] === 'enc') {
                  keyAgreementRefs[eventIndex] = pk.id
                }
                break
              }
              case 'svc':
                // eslint-disable-next-line no-case-declarations
                const value = Buffer.from(currentEvent.value.slice(2), 'hex').toString()
                // eslint-disable-next-line no-case-declarations
                const valueMatch = value.match(/(.*)##(\w+)##(\w+)/)

                // console.log('Resolver : parsing svc', value)

                serviceCount++
                services[eventIndex] = {
                  // id: `${did}#service-${serviceCount}`,
                  id: `${did}?context=${valueMatch?.[2]}#${valueMatch?.[3]}`,
                  type: algorithm,
                  // serviceEndpoint: Buffer.from(currentEvent.value.slice(2), 'hex').toString(),
                  serviceEndpoint: valueMatch?.[1] ?? '',
                }
                break
            }
          }
        }
      } else if (event._eventName === eventNames.DIDOwnerChanged) {
        const currentEvent = <DIDOwnerChanged>event
        controller = currentEvent.owner
        if (currentEvent.owner === nullAddress) {
          deactivated = true
          break
        }
      } else {
        if (
          event._eventName === eventNames.DIDDelegateChanged ||
          (event._eventName === eventNames.DIDAttributeChanged &&
            (<DIDAttributeChanged>event).name.match(/^did\/pub\//))
        ) {
          delegateCount++
        } else if (
          event._eventName === eventNames.DIDAttributeChanged &&
          (<DIDAttributeChanged>event).name.match(/^did\/svc\//)
        ) {
          serviceCount++
        }
        delete auth[eventIndex]
        delete pks[eventIndex]
        delete services[eventIndex]
      }
    }

    const publicKeys: VerificationMethod[] = [
      {
        id: `${did}#controller`,
        type: verificationMethodTypes.EcdsaSecp256k1RecoveryMethod2020,
        controller: did,
        blockchainAccountId: `${controller}@eip155:${chainId}`,
      },
    ]

    if (controllerKey && controller == address) {
      publicKeys.push({
        id: `${did}#controllerKey`,
        type: verificationMethodTypes.EcdsaSecp256k1VerificationKey2019,
        controller: did,
        publicKeyHex: strip0x(controllerKey),
      })
      authentication.push(`${did}#controllerKey`)
    }

    const didDocument: DIDDocument = {
      ...baseDIDDocument,
      verificationMethod: publicKeys.concat(Object.values(pks)),
      authentication: authentication.concat(Object.values(auth)),
    }
    if (Object.values(services).length > 0) {
      didDocument.service = Object.values(services)
    }
    if (Object.values(keyAgreementRefs).length > 0) {
      didDocument.keyAgreement = keyAgreement.concat(Object.values(keyAgreementRefs))
    }
    didDocument.assertionMethod = [...(didDocument.verificationMethod?.map((pk) => pk.id) || [])]

    return deactivated
      ? {
          didDocument: { ...baseDIDDocument, '@context': 'https://www.w3.org/ns/did/v1' },
          deactivated,
          versionId,
          nextVersionId,
        }
      : { didDocument, deactivated, versionId, nextVersionId }
  }

  async resolve(
    did: string,
    parsed: ParsedDID,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _unused: Resolvable,
    options: DIDResolutionOptions
  ): Promise<DIDResolutionResult> {
    const fullId = parsed.id.match(identifierMatcher)
    if (!fullId) {
      return {
        didResolutionMetadata: {
          error: Errors.invalidDid,
          message: `Not a valid did:ethr: ${parsed.id}`,
        },
        didDocumentMetadata: {},
        didDocument: null,
      }
    }
    const id = fullId[2]
    const networkId = !fullId[1] ? 'mainnet' : fullId[1].slice(0, -1)
    let blockTag: string | number = options.blockTag || 'latest'
    if (typeof parsed.query === 'string') {
      const qParams = new URLSearchParams(parsed.query)
      blockTag = qParams.get('versionId') ?? blockTag
      try {
        blockTag = Number.parseInt(<string>blockTag)
      } catch (e) {
        blockTag = 'latest'
        // invalid versionId parameters are ignored
      }
    }

    let now = BigNumber.from(Math.floor(new Date().getTime() / 1000))

    if (typeof blockTag === 'number') {
      const block = await this.getBlockMetadata(blockTag)
      now = BigNumber.from(Date.parse(block.isoDate) / 1000)
    } else {
      // 'latest'
    }

    const { address, history, controllerKey, chainId } = await this.changeLog(id, 'latest')
    try {
      const { didDocument, deactivated, versionId, nextVersionId } = this.wrapDidDocument(
        did,
        address,
        controllerKey,
        history,
        chainId,
        blockTag,
        now
      )
      const status = deactivated ? { deactivated: true } : {}
      let versionMeta = {}
      let versionMetaNext = {}
      if (versionId !== 0) {
        const block = await this.getBlockMetadata(versionId)
        versionMeta = {
          versionId: block.height,
          updated: block.isoDate,
        }
      }
      if (nextVersionId !== Number.POSITIVE_INFINITY) {
        const block = await this.getBlockMetadata(nextVersionId)
        versionMetaNext = {
          nextVersionId: block.height,
          nextUpdate: block.isoDate,
        }
      }
      return {
        didDocumentMetadata: { ...status, ...versionMeta, ...versionMetaNext },
        didResolutionMetadata: { contentType: 'application/did+ld+json' },
        didDocument,
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return {
        didResolutionMetadata: {
          error: Errors.notFound,
          message: e.toString(), // This is not in spec, nut may be helpful
        },
        didDocumentMetadata: {},
        didDocument: null,
      }
    }
  }

  build(): Record<string, DIDResolver> {
    return { ethr: this.resolve.bind(this) }
  }
}
