import BigNumber from "bignumber.js";
import BN = require("bn.js");
import { Constants, roundToFloatValue } from "loopringV3.js";
import { expectThrow } from "./expectThrow";
import { BalanceSnapshot, ExchangeTestUtil } from "./testExchangeUtil";
import { AuthMethod, Deposit, SpotTrade, OrderInfo, BatchSpotTradeUser, BatchSpotTrade } from "./types";

contract("Exchange", (accounts: string[]) => {
  let exchangeTestUtil: ExchangeTestUtil;
  let exchange: any;
  let depositContract: any;
  let loopring: any;
  let exchangeID = 0;

  const depositChecked = async (
    from: string,
    to: string,
    token: string,
    amount: BN
  ) => {
    const snapshot = new BalanceSnapshot(exchangeTestUtil);
    await snapshot.watchBalance(to, token, "recipient");
    await snapshot.transfer(
      from,
      depositContract.address,
      token,
      amount,
      "from",
      "depositContract"
    );

    const ethAddress = exchangeTestUtil.getTokenAddress("ETH");
    const ethValue = token === ethAddress ? amount : 0;
    // Deposit
    await exchange.deposit(from, to, token, amount, "0x", {
      from: from,
      value: ethValue,
      gasPrice: 0
    });

    // Verify balances
    await snapshot.verifyBalances();

    // Get the Deposit event
    const event = await exchangeTestUtil.assertEventEmitted(
      exchange,
      "DepositRequested"
    );
    assert.equal(event.to, to, "owner unexpected");
    assert.equal(
      event.token,
      exchangeTestUtil.getTokenAddress(token),
      "token unexpected"
    );
    assert(event.amount.eq(amount), "amount unexpected");
  };

  const submitWithdrawalBlockChecked = async (
    deposits: Deposit[],
    expectedSuccess?: boolean[],
    expectedTo?: string[],
    blockFee?: BN
  ) => {
    assert.equal(
      exchangeTestUtil.pendingBlocks[exchangeID].length,
      1,
      "unexpected number of pending blocks"
    );
    const block = exchangeTestUtil.pendingBlocks[exchangeID][0];

    // Block fee
    const feeRecipient = exchangeTestUtil.exchangeOperator;
    blockFee = new BN(0);
    let numWithdrawals = 0;
    for (const tx of block.internalBlock.transactions) {
      if (tx.txType === "Withdraw") {
        numWithdrawals++;
        if (tx.type >= 2) {
          blockFee.iadd(tx.withdrawalFee);
        }
      } else if (tx.txType === "Deposit") {
      }
    }

    if (expectedSuccess === undefined) {
      expectedSuccess = new Array(numWithdrawals).fill(true);
    }

    if (expectedTo === undefined) {
      expectedTo = new Array(deposits.length).fill(Constants.zeroAddress);
      for (const [i, deposit] of deposits.entries()) {
        expectedTo[i] =
          deposit.owner === Constants.zeroAddress
            ? await loopring.protocolFeeVault()
            : deposit.owner;
      }
    }

    // Simulate all transfers
    const snapshot = new BalanceSnapshot(exchangeTestUtil);
    // Simulate withdrawals
    for (const [i, deposit] of deposits.entries()) {
      await snapshot.transfer(
        depositContract.address,
        expectedTo[i],
        deposit.token,
        expectedSuccess[i] ? deposit.amount : new BN(0),
        "depositContract",
        "to"
      );
    }
    // Simulate block fee payment
    // await snapshot.transfer(
    //   exchange.address,
    //   feeRecipient,
    //   "ETH",
    //   blockFee,
    //   "exchange",
    //   "feeRecipient"
    // );

    // Submit the block
    await exchangeTestUtil.submitPendingBlocks();

    // Verify balances
    await snapshot.verifyBalances();

    // Check events
    // WithdrawalCompleted events
    {
      const numEventsExpected = expectedSuccess.filter(x => x === true).length;
      const events = await exchangeTestUtil.assertEventsEmitted(
        exchange,
        "WithdrawalCompleted",
        numEventsExpected
      );
      let c = 0;
      for (const [i, deposit] of deposits.entries()) {
        if (expectedSuccess[i]) {
          assert.equal(events[c].from, deposit.owner, "from should match");
          assert.equal(events[c].to, expectedTo[i], "to should match");
          assert.equal(events[c].token, deposit.token, "token should match");
          assert(events[c].amount.eq(deposit.amount), "amount should match");
          c++;
        }
      }
      assert.equal(
        events.length,
        c,
        "Unexpected num WithdrawalCompleted events"
      );
    }
    // WithdrawalFailed events
    {
      const numEventsExpected = expectedSuccess.filter(x => x === false).length;
      const events = await exchangeTestUtil.assertEventsEmitted(
        exchange,
        "WithdrawalFailed",
        numEventsExpected
      );
      let c = 0;
      for (const [i, deposit] of deposits.entries()) {
        if (!expectedSuccess[i]) {
          assert.equal(events[c].from, deposit.owner, "from should match");
          assert.equal(events[c].to, expectedTo[i], "to should match");
          assert.equal(events[c].token, deposit.token, "token should match");
          assert(events[c].amount.eq(deposit.amount), "amount should match");
          c++;
        }
      }
      assert.equal(events.length, c, "Unexpected num WithdrawalFailed events");
    }

    // Check the BlockSubmitted event
    const event = await exchangeTestUtil.assertEventEmitted(
      exchange,
      "BlockSubmitted"
    );
    assert.equal(
      event.blockIdx.toNumber(),
      block.blockIdx,
      "Unexpected block idx"
    );
  };

  const withdrawOnceChecked = async (
    owner: string,
    token: string,
    expectedAmount: BN
  ) => {
    const snapshot = new BalanceSnapshot(exchangeTestUtil);
    await snapshot.transfer(
      depositContract.address,
      owner,
      token,
      expectedAmount,
      "depositContract",
      "owner"
    );

    // Check how much will be withdrawn
    const onchainAmountWithdrawableBefore = await exchange.getAmountWithdrawable(
      owner,
      token
    );
    assert(
      onchainAmountWithdrawableBefore.eq(expectedAmount),
      "unexpected withdrawable amount"
    );

    await exchange.withdrawFromApprovedWithdrawals([owner], [token], {
      from: exchangeTestUtil.testContext.orderOwners[10]
    });

    // Complete amount needs to be withdrawn
    const onchainAmountWithdrawableAfter = await exchange.getAmountWithdrawable(
      owner,
      token
    );
    assert(
      onchainAmountWithdrawableAfter.eq(new BN(0)),
      "unexpected withdrawable amount"
    );

    // Verify balances
    await snapshot.verifyBalances();

    // Get the WithdrawalCompleted event
    const event = await exchangeTestUtil.assertEventEmitted(
      exchange,
      "WithdrawalCompleted"
    );
    assert.equal(event.from, owner, "from unexpected");
    assert.equal(event.to, owner, "to unexpected");
    assert.equal(event.token, token, "token unexpected");
    assert(event.amount.eq(expectedAmount), "amount unexpected");
  };

  const withdrawChecked = async (
    owner: string,
    token: string,
    expectedAmount: BN
  ) => {
    // Withdraw
    await withdrawOnceChecked(owner, token, expectedAmount);
    // Withdraw again, no tokens should be transferred
    await withdrawOnceChecked(owner, token, new BN(0));
  };

  const createExchange = async (setupTestState: boolean = true) => {
    exchangeID = await exchangeTestUtil.createExchange(
      exchangeTestUtil.testContext.stateOwners[0],
      { setupTestState }
    );
    exchange = exchangeTestUtil.exchange;
    depositContract = exchangeTestUtil.depositContract;
  };

  before(async () => {
    exchangeTestUtil = new ExchangeTestUtil();
    await exchangeTestUtil.initialize(accounts);
    exchange = exchangeTestUtil.exchange;
    loopring = exchangeTestUtil.loopringV3;
    depositContract = exchangeTestUtil.depositContract;
    exchangeID = 1;
  });

  after(async () => {
    await exchangeTestUtil.stop();
  });

  describe("AccountInit", function() {
    this.timeout(0);

    it("AppKey Use", async () => {
      await createExchange();

      const ownerA = exchangeTestUtil.testContext.orderOwners[0];
      const ownerB = exchangeTestUtil.testContext.orderOwners[1];
      const ownerC = exchangeTestUtil.testContext.orderOwners[2];
      const ownerD = exchangeTestUtil.testContext.orderOwners[3];

      await exchangeTestUtil.deposit(
        ownerD,
        ownerD,
        "GTO",
        new BN(web3.utils.toWei("200", "ether")),
        { autoSetKeys: true }
      );
      await exchangeTestUtil.deposit(
        ownerD,
        ownerD,
        "WETH",
        new BN(web3.utils.toWei("200", "ether")),
        { autoSetKeys: false }
      );

      // appKey update
      let keyPair = exchangeTestUtil.getKeyPairEDDSA();
      await exchangeTestUtil.requestAppKeyUpdate(
        ownerD,
        "WETH",
        new BN(web3.utils.toWei("0.03", "ether")),
        keyPair,
        0,
        0,
        0
      );

      // AppKey Transfer
      await exchangeTestUtil.transfer(
        ownerD,
        ownerC,
        "GTO",
        new BN(web3.utils.toWei("2", "ether")),
        "WETH",
        new BN(web3.utils.toWei("0.01", "ether")),
        {
          authMethod: AuthMethod.EDDSA,
          amountToDeposit: new BN(0),
          feeToDeposit: new BN(0),
        },
        1
      );
      
      // withdraw
      const requestWithdraw = await exchangeTestUtil.requestWithdrawal(
        ownerD,
        "GTO",
        new BN(web3.utils.toWei("2", "ether")),
        "WETH",
        new BN(web3.utils.toWei("0.02", "ether")),
        { authMethod: AuthMethod.EDDSA, storeRecipient: true },
        1
      );

      // cancel
      exchangeTestUtil.requestOrderCancel(
        ownerD,
        4,
        new BN("21000000000000"),
        new BN("21000000000000"),
        "GTO",
        1
      );

      await exchangeTestUtil.submitTransactions(12, false);
      // Submit the block
      await exchangeTestUtil.submitPendingBlocks();
    });

    it("AppKey BatchSpotTrade", async () => {
      await createExchange();

      const ownerC = exchangeTestUtil.testContext.orderOwners[2];
      const ownerD = exchangeTestUtil.testContext.orderOwners[3];

      const depositTo2 = await exchangeTestUtil.deposit(
        ownerC,
        ownerC,
        "GTO",
        new BN(web3.utils.toWei("200", "ether")),
        { autoSetKeys: true }
      );
      const depositToETH2 = await exchangeTestUtil.deposit(
        ownerC,
        ownerC,
        "ETH",
        new BN(web3.utils.toWei("200", "ether")),
        { autoSetKeys: false }
      );

      const depositTo3 = await exchangeTestUtil.deposit(
        ownerD,
        ownerD,
        "GTO",
        new BN(web3.utils.toWei("200", "ether")),
        { autoSetKeys: true }
      );
      const depositToETH3 = await exchangeTestUtil.deposit(
        ownerD,
        ownerD,
        "ETH",
        new BN(web3.utils.toWei("200", "ether")),
        { autoSetKeys: false }
      );

      // appKey update
      let keyPair = exchangeTestUtil.getKeyPairEDDSA();
      await exchangeTestUtil.requestAppKeyUpdate(
        ownerD,
        "ETH",
        new BN(web3.utils.toWei("0.03", "ether")),
        keyPair,
        0,
        0,
        0
      );

      // spot trade
      {
        const orderA: OrderInfo = {
          tokenS: "ETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("0.5", "ether")),
          owner: ownerD,
          feeBips: 18, // can not more than protocolFeeBips
          fillAmountBorS: true,
          feeTokenID: 0,
          fee: new BN("12300000000000"),
          maxFee: new BN("12300000000000"),
          useAppKey: 1
        };
        const orderB: OrderInfo = {
          tokenS: "GTO",
          tokenB: "ETH",
          amountS: new BN(web3.utils.toWei("4", "ether")),
          amountB: new BN(web3.utils.toWei("2", "ether")),
          owner: ownerC,
          feeBips: 0, // can not more than protocolFeeBips
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("21000000000000"),
          maxFee: new BN("21000000000000"),
          useAppKey: 0
        };

        const spread = new BN(web3.utils.toWei("1", "ether"));
        const ringA: SpotTrade = {
          orderA: orderA,
          orderB: orderB,
          expected: {
            orderA: { filledFraction: 1.0, spread },
            orderB: { filledFraction: 0.5 }
          }
        };

        await exchangeTestUtil.setupRing(ringA, true, true, true, true);
        await exchangeTestUtil.sendRing(ringA);
      }

      // BatchSpotTrade
      {
        const orderA: OrderInfo = {
          tokenS: "ETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("1", "ether")),
          owner: ownerD,
          feeBips: 18, // can not more than protocolFeeBips
          fillAmountBorS: true,
          feeTokenID: 0,
          fee: new BN("12000000000000000"),
          maxFee: new BN("12000000000000000"),
          deltaFilledS: new BN("1000000000000000000"),
          deltaFilledB: new BN("1000000000000000000"),
          useAppKey: 1
        };
        const orderB: OrderInfo = {
          tokenS: "GTO",
          tokenB: "ETH",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("1", "ether")),
          owner: ownerC,
          feeBips: 0, // can not more than protocolFeeBips
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("21000000000000000"),
          maxFee: new BN("21000000000000000"),
          deltaFilledS: new BN("1000000000000000000"),
          deltaFilledB: new BN("1000000000000000000"),
        };

        const orderC: OrderInfo = {
          tokenS: "ETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("2", "ether")),
          amountB: new BN(web3.utils.toWei("2", "ether")),
          owner: ownerD,
          feeBips: 18, // can not more than protocolFeeBips
          fillAmountBorS: true,
          feeTokenID: 0,
          fee: new BN("22000000000000000"),
          maxFee: new BN("22000000000000000"),
          deltaFilledS: new BN("2000000000000000000"),
          deltaFilledB: new BN("2000000000000000000"),
        };
        const orderD: OrderInfo = {
          tokenS: "GTO",
          tokenB: "ETH",
          amountS: new BN(web3.utils.toWei("2", "ether")),
          amountB: new BN(web3.utils.toWei("2", "ether")),
          owner: ownerC,
          feeBips: 0, // can not more than protocolFeeBips
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("31000000000000000"),
          maxFee: new BN("31000000000000000"),
          deltaFilledS: new BN("2000000000000000000"),
          deltaFilledB: new BN("2000000000000000000"),
        };
        
        
        const orderE: OrderInfo = {
          tokenS: "ETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("2", "ether")),
          amountB: new BN(web3.utils.toWei("2", "ether")),
          owner: ownerD,
          feeBips: 18, // can not more than protocolFeeBips
          fillAmountBorS: true,
          feeTokenID: 0,
          fee: new BN("42000000000000000"),
          maxFee: new BN("42000000000000000"),
          deltaFilledS: new BN("2000000000000000000"),
          deltaFilledB: new BN("2000000000000000000"),
        };
        const orderF: OrderInfo = {
          tokenS: "GTO",
          tokenB: "ETH",
          amountS: new BN(web3.utils.toWei("2", "ether")),
          amountB: new BN(web3.utils.toWei("2", "ether")),
          owner: ownerC,
          feeBips: 0, // can not more than protocolFeeBips
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("51000000000000000"),
          maxFee: new BN("51000000000000000"),
          deltaFilledS: new BN("2000000000000000000"),
          deltaFilledB: new BN("2000000000000000000"),
        };
        const orderG: OrderInfo = {
          tokenS: "ETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("1", "ether")),
          owner: ownerD,
          feeBips: 18, // can not more than protocolFeeBips
          fillAmountBorS: true,
          feeTokenID: 0,
          fee: new BN("62000000000000000"),
          maxFee: new BN("62000000000000000"),
          deltaFilledS: new BN("1000000000000000000"),
          deltaFilledB: new BN("1000000000000000000"),
        };
        const orderH: OrderInfo = {
          tokenS: "GTO",
          tokenB: "ETH",
          amountS: new BN(web3.utils.toWei("1", "ether")),
          amountB: new BN(web3.utils.toWei("1", "ether")),
          owner: ownerC,
          feeBips: 0, // can not more than protocolFeeBips
          fillAmountBorS: false,
          feeTokenID: 0,
          fee: new BN("71000000000000000"),
          maxFee: new BN("71000000000000000"),
          deltaFilledS: new BN("1000000000000000000"),
          deltaFilledB: new BN("1000000000000000000"),
        };


        const batchSpotTradeUser1: BatchSpotTradeUser = {
          orders: [orderA, orderC, orderE],
        };
        const batchSpotTradeUser2: BatchSpotTradeUser = {
          orders: [orderB, orderD],
        };
        const batchSpotTradeUser3: BatchSpotTradeUser = {
          orders: [orderG],
        };
        const batchSpotTradeUser4: BatchSpotTradeUser = {
          orders: [orderH],
        };
        const batchSpotTradeUser5: BatchSpotTradeUser = {
          orders: [orderF],
        };
        
        const spread = new BN(web3.utils.toWei("1", "ether"));
        const batchSpotTrade: BatchSpotTrade = {
          users: [batchSpotTradeUser1, batchSpotTradeUser2, batchSpotTradeUser3, batchSpotTradeUser4, batchSpotTradeUser5],
          tokens: [2,3,0],
          expected: {
            orderA: { filledFraction: 1.0, spread },
            orderB: { filledFraction: 0.5 }
          },
          bindTokenID: 0
        };


        await exchangeTestUtil.setupBatchSpotTrade(batchSpotTrade);
        await exchangeTestUtil.sendBatchSpotTrade(batchSpotTrade);
      }

      await exchangeTestUtil.submitTransactions(13, false);
      // Submit the block
      await exchangeTestUtil.submitPendingBlocks();
    });
  });
});
