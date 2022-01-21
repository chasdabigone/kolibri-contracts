import { compileLambda, } from '@hover-labs/tezos-utils'
import { KOLIBRI_CONFIG, MIGRATION_CONFIG } from '../config'

const main = async () => {
    // Contracts
    const devFundContract = KOLIBRI_CONFIG.contracts.DEVELOPER_FUND!
    const communityFundContract = KOLIBRI_CONFIG.contracts.DAO_COMMUNITY_FUND!

    // Break Glasses
    const devFundBreakGlassContract = KOLIBRI_CONFIG.contracts.BREAK_GLASS_CONTRACTS.DEVELOPER_FUND
    const communityFundBreakGlassContract = KOLIBRI_CONFIG.contracts.BREAK_GLASS_CONTRACTS.DAO_COMMUNITY_FUND

    const program = `
import smartpy as sp

def movekusd(unit):
    sp.set_type(unit, sp.TUnit)

    contractHandle = sp.contract(
        sp.TAddress,
        sp.address("${devFundContract}"),
        "sendTokens"
    ).open_some()

    param = (sp.nat(${amountKUSD.toFixed()}), sp.address("${recipientAddress}"))

    sp.result(
        [
            sp.transfer_operation(
                sp.address("${nullAdddress}"),
                sp.mutez(0),
                contractHandle
            )
        ]
    )  

def governanceLambda(unit):
    sp.set_type(unit, sp.TUnit)

    liquidityPoolBreakGlassLambda = sp.contract(
        sp.TLambda(sp.TUnit, sp.TList(sp.TOperation)),
        sp.address("${liquidityPoolBreakGlassContract}"),
        "runLambda"
    ).open_some()

    sp.result(
        [
            sp.transfer_operation(setQuipuswapPoolLambda, sp.mutez(0), liquidityPoolBreakGlassLambda),
        ]
    )

sp.add_expression_compilation_target("operation", governanceLambda)
        `

    const compiled = compileLambda(program)

    console.log("Governance Lambda:")
    console.log(compiled)
}

main()
