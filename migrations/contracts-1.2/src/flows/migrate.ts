import { KOLIBRI_CONFIG, MIGRATION_CONFIG, NETWORK_CONFIG } from "../config"
import { ContractOriginationResult, loadContract, printConfig, sendOperation, getTezos, fetchFromCacheOrRun, deployContract } from "@hover-labs/tezos-utils"
import { generateBreakGlassStorage } from '../storage/break-glass-contract-storage'
import { generateStabilityFundStorage } from '../storage/stability-fund-contract-storage'
import { generateSavingsPoolStorage } from "../storage/savings-pool-contract-storage"
import CACHE_KEYS from '../cache-keys'
import BigNumber from 'bignumber.js'

const main = async () => {
  // Debug Info
  console.log("Migrating contracts to 1.2")
  printConfig(NETWORK_CONFIG)
  console.log('')

  // Init Deployer
  console.log("Initializing Deployer Account")
  const tezos = await getTezos(NETWORK_CONFIG)
  console.log("Deployer initialized!")
  console.log('')

  // Load Contract Soruces
  console.log("Loading Contracts...")
  const contractSources = {
    stabilityFundContractSource: loadContract(`${__dirname}/../../../../smart_contracts/stability-fund.tz`),
    savingsPoolContractSource: loadContract(`${__dirname}/../../../../smart_contracts/savings-pool.tz`),
    breakGlassContractSource: loadContract(`${__dirname}/../../../../break-glass-contracts/smart_contracts/break-glass.tz`)
  }
  console.log("Done!")
  console.log('')

  // Deploy Pipeline

  // Step 0: Deploy a new stability fund
  console.log('Deploying a new Stability Fund')
  const stabilityFundDeployResult: ContractOriginationResult = await fetchFromCacheOrRun(CACHE_KEYS.STABILITY_FUND_DEPLOY, async () => {
    const params = {
      governorContractAddress: await tezos.signer.publicKeyHash(),
      savingsAccountContractAddress: await tezos.signer.publicKeyHash()
    }
    const stabilityFundStorage = await generateStabilityFundStorage(params, KOLIBRI_CONFIG.contracts.STABILITY_FUND!, tezos)
    return deployContract(NETWORK_CONFIG, tezos, contractSources.stabilityFundContractSource, stabilityFundStorage)
  })
  console.log('')

  // Step 1: Deploy the stability fund break glass
  console.log('Deploying a Break Glass for the new Stability Fund')
  const stabilityFundBreakGlassDeployResult: ContractOriginationResult = await fetchFromCacheOrRun(CACHE_KEYS.STABILITY_FUND_BREAK_GLASS_DEPLOY, async () => {
    const breakGlassStorage = generateBreakGlassStorage(
      {
        daoAddress: KOLIBRI_CONFIG.contracts.DAO!,
        multisigAddress: KOLIBRI_CONFIG.contracts.BREAK_GLASS_MULTISIG!,
        targetAddress: stabilityFundDeployResult.contractAddress

      }
    )
    return deployContract(NETWORK_CONFIG, tezos, contractSources.breakGlassContractSource, breakGlassStorage)
  })
  console.log('')

  // Step 3: Deploy the savings pool
  console.log('Deploying Savings Pool')
  const savingsPoolDeployResult: ContractOriginationResult = await fetchFromCacheOrRun(CACHE_KEYS.SAVINGS_POOL_DEPLOY, async () => {
    const params = {
      governorAddress: await tezos.signer.publicKeyHash(),
      interestRate: MIGRATION_CONFIG.initialInterestRate.toNumber(),
      pauseGuardianAddress: KOLIBRI_CONFIG.contracts.PAUSE_GUARDIAN!,
      stabilityFundAddress: stabilityFundDeployResult.contractAddress,
      tokenAddress: KOLIBRI_CONFIG.contracts.TOKEN!
    }
    const savingsPoolStorage = await generateSavingsPoolStorage(params)
    return deployContract(NETWORK_CONFIG, tezos, contractSources.savingsPoolContractSource, savingsPoolStorage)
  })
  console.log('')

  // Step 4: Deploy the stability fund break glass
  console.log('Deploying a Break Glass for the Savings Pool')
  const savingsPoolBreakGlassDeployResult: ContractOriginationResult = await fetchFromCacheOrRun(CACHE_KEYS.SAVINGS_POOL_BREAK_GLASS_DEPLOY, async () => {
    const breakGlassStorage = generateBreakGlassStorage(
      {
        daoAddress: KOLIBRI_CONFIG.contracts.DAO!,
        multisigAddress: KOLIBRI_CONFIG.contracts.BREAK_GLASS_MULTISIG!,
        targetAddress: savingsPoolDeployResult.contractAddress

      }
    )
    return deployContract(NETWORK_CONFIG, tezos, contractSources.breakGlassContractSource, breakGlassStorage)
  })
  console.log('')

  // Step 5: Wire the stability fund to use the savings pool
  console.log('Wiring the Stability Fund to the Savings Pool')
  const wireStabilityFundHash: string = await fetchFromCacheOrRun(CACHE_KEYS.WIRE_STABILITY_FUND_AND_SAVINGS_POOL, async () => {
    return sendOperation(
      NETWORK_CONFIG,
      tezos,
      stabilityFundDeployResult.contractAddress,
      'setSavingsAccountContract',
      savingsPoolDeployResult.contractAddress
    )
  })
  console.log('')

  // Step 6: Wire the stability fund to use the savings pool
  console.log('Wiring the Stability Fund to use the Break Glass as the Governor')
  const wireGovernorStabilityFundHash: string = await fetchFromCacheOrRun(CACHE_KEYS.WIRE_STABILITY_FUND_BREAK_GLASS, async () => {
    return sendOperation(
      NETWORK_CONFIG,
      tezos,
      stabilityFundDeployResult.contractAddress,
      'setGovernorContract',
      stabilityFundBreakGlassDeployResult.contractAddress
    )
  })

  // Step 7: Wire the stability fund to use the savings pool
  console.log('Wiring the Savings Pool to use the Break Glass as the Governor')
  const wireGovernorSavingsPoolHash: string = await fetchFromCacheOrRun(CACHE_KEYS.WIRE_SAVINGS_POOL_BREAK_GLASS, async () => {
    return sendOperation(
      NETWORK_CONFIG,
      tezos,
      savingsPoolDeployResult.contractAddress,
      'setGovernorContract',
      savingsPoolBreakGlassDeployResult.contractAddress
    )
  })

  // Step 8: Fund the funds
  // Give the stability fund some value by transferring 1 kUSD from the deployer to the stability fund.
  //
  // This works around a bug where on Sandbox net there is 0 value in the stability fund. Because the token
  // contract will FAIL_WITH when an account which has never held a token calls the `transfer` entrypoint later 
  // calls to move value from old stability fund to new stability fund will fail.
  //
  // Additionally, the automated tests assume there is *some* value in the stability fund to start in order to
  // validate the transfer occurred, so we need some value here. 
  console.log("Transferring 1 kUSD to the old stability fund to ensure it has value")
  const oldStabilityFundTransferResult = await fetchFromCacheOrRun(CACHE_KEYS.OLD_STABILITY_FUND_TRANSFER, async () => {
    const tokenContractAddress = KOLIBRI_CONFIG.contracts.TOKEN!
    const oldStabilityFundAddress = KOLIBRI_CONFIG.contracts.STABILITY_FUND!
    const deployerAddress = await tezos.signer.publicKeyHash()
    const amount = new BigNumber("1000000000000000000") // 1 kUSD

    const transferParam = [
      deployerAddress,
      oldStabilityFundAddress,
      amount
    ]
    return sendOperation(NETWORK_CONFIG, tezos, tokenContractAddress, 'transfer', transferParam)
  })

  console.log("Transferring 1 kUSD to the new stability fund to ensure it has value")
  const newStabilityFundTransferResult = await fetchFromCacheOrRun(CACHE_KEYS.NEW_STABILITY_FUND_TRANSFER, async () => {
    const tokenContractAddress = KOLIBRI_CONFIG.contracts.TOKEN!
    const newStabilityFundAddress = stabilityFundDeployResult.contractAddress
    const deployerAddress = await tezos.signer.publicKeyHash()
    const amount = new BigNumber("1000000000000000000") // 1 kUSD

    const transferParam = [
      deployerAddress,
      newStabilityFundAddress,
      amount
    ]
    return sendOperation(NETWORK_CONFIG, tezos, tokenContractAddress, 'transfer', transferParam)
  })

  console.log("Transferring 1 kUSD to the new savings pool to ensure it has value")
  const savingsPoolTransferResult = await fetchFromCacheOrRun(CACHE_KEYS.SAVINGS_POOL_TRANSFER, async () => {
    const tokenContractAddress = KOLIBRI_CONFIG.contracts.TOKEN!
    const savingsPoolAddress = savingsPoolDeployResult.contractAddress
    const deployerAddress = await tezos.signer.publicKeyHash()
    const amount = new BigNumber("1000000000000000000") // 1 kUSD

    const transferParam = [
      deployerAddress,
      savingsPoolAddress,
      amount
    ]
    return sendOperation(NETWORK_CONFIG, tezos, tokenContractAddress, 'transfer', transferParam)
  })

  // Print Results
  console.log("----------------------------------------------------------------------------")
  console.log("Operation Results")
  console.log("----------------------------------------------------------------------------")

  console.log("Contracts:")
  console.log(`New Stability Fund Contract:             ${stabilityFundDeployResult.contractAddress} / ${stabilityFundDeployResult.operationHash}`)
  console.log(`New Stability Fund Break Glass Contract: ${stabilityFundBreakGlassDeployResult.contractAddress} / ${stabilityFundBreakGlassDeployResult.operationHash}`)
  console.log(`New Savings Pool Contract:               ${savingsPoolDeployResult.contractAddress} / ${savingsPoolDeployResult.operationHash}`)
  console.log(`New Savings Pool Break Glass Contract:   ${savingsPoolBreakGlassDeployResult.contractAddress} / ${savingsPoolBreakGlassDeployResult.operationHash}`)
  console.log("")

  console.log("Operations:")
  console.log(`Ensure Old Stability Fund has Value: ${oldStabilityFundTransferResult}`)
  console.log(`Ensure New Stability Fund has Value: ${newStabilityFundTransferResult}`)
  console.log(`Ensure Savings Pool has Value: ${savingsPoolTransferResult}`)
  console.log(`Wire Savings Pool To Stability Fund: ${wireStabilityFundHash}`)
  console.log(`Wire Break Glass To Stability Pool: ${wireGovernorStabilityFundHash}`)
  console.log(`Wire Break Glass To Savings Pool: ${wireGovernorSavingsPoolHash}`)

  console.log("")

}

main()