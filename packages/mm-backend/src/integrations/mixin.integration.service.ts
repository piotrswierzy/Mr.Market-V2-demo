import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import {
  base64RawURLEncode,
  buildSafeTransaction,
  buildSafeTransactionRecipient,
  encodeSafeTransaction,
  getED25519KeyPair,
  getUnspentOutputsForRecipients,
  Keystore,
  KeystoreClientReturnType,
  MixinApi,
  MixinCashier,
  SafeAsset,
  SafeUtxoOutput,
  SafeWithdrawalRecipient,
  signSafeTransaction,
} from '@mixin.dev/mixin-node-sdk';
import { ConfigService } from '@nestjs/config';
import {
  ClientSession,
  OAuthResponse,
} from '../common/interfaces/auth.interfaces';
import { DepositCommand } from '../modules/mixin/deposit/model/mixin-deposit.model';
import { v4 } from 'uuid';
import { Fee } from '../common/interfaces/mixin.interfaces';
import { WithdrawCommand } from '../modules/mixin/withdrawal/model/mixin-withdrawal.model';
import { Decimal } from 'decimal.js';

@Injectable()
export class MixinIntegrationService implements OnModuleInit {
  private readonly logger = new Logger(MixinIntegrationService.name);
  private readonly keystore: Keystore;
  private readonly _clientSecret: string;
  private _client: KeystoreClientReturnType;
  private readonly spendPrivateKey: string;
  private readonly scope: string;
  private isConfigured: boolean = false;

  constructor(private configService: ConfigService) {
    const appId = this.configService.get<string>('MIXIN_APP_ID');
    const sessionId = this.configService.get<string>('MIXIN_SESSION_ID');
    const serverPublicKey = this.configService.get<string>('MIXIN_SERVER_PUBLIC_KEY');
    const sessionPrivateKey = this.configService.get<string>('MIXIN_SESSION_PRIVATE_KEY');
    const oauthSecret = this.configService.get<string>('MIXIN_OAUTH_SECRET');
    const spendPrivateKey = this.configService.get<string>('MIXIN_SPEND_PRIVATE_KEY');

    this.isConfigured = !!(appId && sessionId && serverPublicKey && sessionPrivateKey && oauthSecret && spendPrivateKey);

    this.keystore = {
      app_id: appId,
      session_id: sessionId,
      server_public_key: serverPublicKey,
      session_private_key: sessionPrivateKey,
    };
    this._clientSecret = oauthSecret;
    this._client = MixinApi({
      keystore: this.keystore,
    });
    this.spendPrivateKey = spendPrivateKey;
    this.scope = this.configService.get<string>(
      'MIXIN_OAUTH_SCOPE',
      'PROFILE:READ ASSETS:READ SNAPSHOTS:READ',
    );
  }

  async onModuleInit() {
    if (!this.isConfigured) {
      this.logger.warn('Mixin integration is not configured. All Mixin-related operations will be disabled.');
      return;
    }

    try {
      await this._client.user.profile();
    } catch (error) {
      throw new Error(
        'Invalid Mixin credentials. code: ' + error.originalError.code,
      );
    }
  }

  private checkMixinConfiguration() {
    if (!this.isConfigured) {
      this.logger.warn('Attempted to use Mixin integration without proper configuration');
      throw new Error('Mixin integration is not configured. Please set all required Mixin environment variables.');
    }
  }

  async oauthHandler(code: string): Promise<OAuthResponse> {
    this.checkMixinConfiguration();
    const { seed, publicKey } = getED25519KeyPair();
    const encodedPublicKey = base64RawURLEncode(publicKey);
    const encodedPrivateKey = Buffer.from(seed).toString('hex');

    const { authorization_id } = await this._client.oauth.getToken({
      client_id: this.keystore.app_id,
      code: code,
      ed25519: encodedPublicKey,
      client_secret: this._clientSecret,
    });

    const userProfile = await this._client.user.profile();

    return {
      clientDetails: {
        clientId: userProfile.user_id,
        type: userProfile.type,
      },
      clientSession: {
        authorizationId: authorization_id,
        privateKey: encodedPrivateKey,
        publicKey: encodedPublicKey,
      },
    };
  }

  private async createMixinClientForUser(
    clientSession: ClientSession,
  ): Promise<KeystoreClientReturnType> {
    const { authorizationId, privateKey } = clientSession;
    const keystore = {
      app_id: this.keystore.app_id,
      scope: this.scope,
      authorization_id: authorizationId,
      session_private_key: privateKey,
    };

    return MixinApi({ keystore });
  }

  async createDepositAddress(command: DepositCommand) {
    this.checkMixinConfiguration();
    const { chainId } = command;
    const payload = {
      members: [this.keystore.app_id],
      threshold: 1,
      chain_id: chainId,
    };

    const response = await this._client.safe.depositEntries(payload);
    return response[0].destination;
  }

  async getUnspentTransactionOutputs() {
    this.checkMixinConfiguration();
    return await this._client.utxo.safeOutputs({
      state: 'unspent',
    });
  }

  async handleWithdrawal(command: WithdrawCommand) {
    this.checkMixinConfiguration();
    const { assetId, destination } = command;
    const asset = await this._client.safe.fetchAsset(assetId);
    const chain = await this.getChainAsset(asset);
    const fees = await this._client.safe.fetchFee(asset.asset_id, destination);
    const transactionFee = this.getTransactionFee(
      fees,
      asset.asset_id,
      chain.asset_id,
    );

    // Check if the withdrawal fee is in a different asset than the one being withdrawn.
    // If the fee is in a different asset, execute the withdrawal process using the chain asset as the fee.
    // Otherwise, execute the withdrawal process using the asset itself as the fee.
    if (this.isFeeInDifferentAsset(transactionFee, asset)) {
      return await this.withdrawWithChainAssetAsFee(command, transactionFee);
    } else {
      return await this.withdrawWithAssetAsFee(command, transactionFee);
    }
  }

  private isFeeInDifferentAsset(fee: Fee, asset: SafeAsset): boolean {
    return fee.asset_id !== asset.asset_id;
  }

  private async getChainAsset(asset: SafeAsset) {
    if (asset.chain_id === asset.asset_id) {
      return asset;
    }
    return await this._client.safe.fetchAsset(asset.chain_id);
  }

  private getTransactionFee(fees: Fee[], assetId: string, chainId: string) {
    const assetFee = fees.find((f) => f.asset_id === assetId);
    const chainFee = fees.find((f) => f.asset_id === chainId);
    return assetFee ?? chainFee;
  }

  private hasPositiveChange(change: Decimal): boolean {
    return !change.isZero() && !change.isNegative();
  }

  private async createRecipientsAndGhosts(
    command: WithdrawCommand,
    outputs: SafeUtxoOutput[],
    additionalRecipient?,
  ) {
    const { amount, destination } = command;

    const sortedOutputs = [...outputs].sort((a, b) =>
      new Decimal(b.amount).minus(new Decimal(a.amount)).toNumber(),
    );

    const recipients: SafeWithdrawalRecipient[] = [
      { amount: amount, destination },
      ...(additionalRecipient ? [additionalRecipient] : []),
    ];

    try {
      const { change } = getUnspentOutputsForRecipients(
        sortedOutputs,
        recipients,
      );

      const decimalChange = new Decimal(change.toString());
      if (this.hasPositiveChange(decimalChange)) {
        recipients.push(
          <SafeWithdrawalRecipient>(
            buildSafeTransactionRecipient(
              sortedOutputs[0].receivers,
              sortedOutputs[0].receivers_threshold,
              change.toString(),
            )
          ),
        );
      }

      const ghosts = await this._client.utxo.ghostKey(
        recipients.filter((r) => 'members' in r),
        v4(),
        this.spendPrivateKey,
      );

      return { recipients, ghosts };
    } catch (error) {
      if (error.message.includes('insufficient total input outputs')) {
        throw new Error(
          `Insufficient balance for withdrawal. Available: ${this.calculateTotalAmount(outputs)}, ` +
            `Required: ${this.calculateTotalRequired(recipients)}`,
        );
      }
      throw error;
    }
  }

  private calculateTotalAmount(outputs: SafeUtxoOutput[]): string {
    return outputs
      .reduce(
        (sum, output) => sum.plus(new Decimal(output.amount)),
        new Decimal(0),
      )
      .toString();
  }

  private calculateTotalRequired(
    recipients: SafeWithdrawalRecipient[],
  ): string {
    return recipients
      .reduce(
        (sum, r) => sum.plus(new Decimal(r.amount.toString())),
        new Decimal(0),
      )
      .toString();
  }

  private async createAndSendTransaction(
    utxos: SafeUtxoOutput[],
    recipients: SafeWithdrawalRecipient[],
    ghosts,
    memo: string,
    feeRef?,
  ) {
    // spare the 0 index for withdrawal output, withdrawal output doesn't need ghost key
    const tx = buildSafeTransaction(
      utxos,
      recipients,
      [undefined, ...ghosts],
      Buffer.from(memo, 'utf-8'),
      feeRef ? [feeRef] : undefined,
    );
    const raw = encodeSafeTransaction(tx);
    const request_id = v4();
    const txs = await this._client.utxo.verifyTransaction([
      { raw, request_id },
    ]);
    const signedRaw = signSafeTransaction(
      tx,
      txs[0].views,
      this.spendPrivateKey,
    );
    const response = await this._client.utxo.sendTransactions([
      { raw: signedRaw, request_id },
    ]);
    return response[0];
  }

  private async withdrawWithChainAssetAsFee(
    command: WithdrawCommand,
    fee: Fee,
  ) {
    const { assetId } = command;

    const outputs = await this._client.utxo.safeOutputs({
      asset: assetId,
      state: 'unspent',
    });

    const totalAvailable = outputs.reduce(
      (sum, output) => sum.plus(new Decimal(output.amount)),
      new Decimal(0),
    );

    if (totalAvailable.lessThan(command.amount.plus(new Decimal(fee.amount)))) {
      throw new Error('Insufficient balance for withdrawal including fees');
    }

    const feeOutputs = await this._client.utxo.safeOutputs({
      asset: fee.asset_id,
      state: 'unspent',
    });

    const { recipients, ghosts } = await this.createRecipientsAndGhosts(
      command,
      outputs,
      fee,
    );

    const feeRecipients = [{ amount: fee.amount, destination: MixinCashier }];
    const { utxos: feeUtxos } = getUnspentOutputsForRecipients(
      feeOutputs,
      feeRecipients,
    );

    const feeCommand: WithdrawCommand = {
      ...command,
      amount: new Decimal(fee.amount),
      destination: MixinCashier,
    };

    const { recipients: feeRecipientsWithChange, ghosts: feeGhosts } =
      await this.createRecipientsAndGhosts(feeCommand, feeOutputs, fee);

    const feeTx = await this.createAndSendTransaction(
      feeUtxos,
      feeRecipientsWithChange,
      feeGhosts,
      'withdrawal-fee-memo',
    );

    return await this.createAndSendTransaction(
      outputs,
      recipients,
      ghosts,
      'withdrawal-memo',
      feeTx,
    );
  }

  private async withdrawWithAssetAsFee(command: WithdrawCommand, fee: Fee) {
    const { assetId } = command;

    const outputs = await this._client.utxo.safeOutputs({
      asset: assetId,
      state: 'unspent',
    });

    const adjustedAmount = command.amount.minus(new Decimal(fee.amount));

    if (adjustedAmount.isNegative()) {
      throw new Error('Withdrawal amount too small to cover fees');
    }

    const feeOutput = buildSafeTransactionRecipient(
      [MixinCashier],
      1,
      fee.amount,
    );
    const { recipients, ghosts } = await this.createRecipientsAndGhosts(
      command,
      outputs,
      feeOutput,
    );

    return await this.createAndSendTransaction(
      outputs,
      recipients,
      ghosts,
      'withdrawal-memo',
    );
  }

  async fetchTransactionDetails(txHash: string) {
    this.checkMixinConfiguration();
    return await this._client.utxo.fetchTransaction(txHash);
  }

  async fetchUserBalanceDetails(clientSession: ClientSession) {
    this.checkMixinConfiguration();
    const client = await this.createMixinClientForUser(clientSession);

    const utxoOutputs = await client.utxo.safeOutputs({ state: 'unspent' });
    const groupedUTXOs = this.groupAndSumUTXOs(utxoOutputs);

    const balanceSummary = await this.calculateBalances(client, groupedUTXOs);

    return {
      balances: balanceSummary.details,
      totalUSDBalance: balanceSummary.totalUSD.toFixed(2),
      totalBTCBalance: balanceSummary.totalBTC.toFixed(8),
    };
  }

  private groupAndSumUTXOs(utxoOutputs: SafeUtxoOutput[]) {
    return Object.values(
      utxoOutputs.reduce(
        (grouped, utxo) => {
          if (!grouped[utxo.asset_id]) {
            grouped[utxo.asset_id] = {
              asset_id: utxo.asset_id,
              amount: new Decimal(0),
            };
          }
          grouped[utxo.asset_id].amount = grouped[utxo.asset_id].amount.plus(
            utxo.amount,
          );
          return grouped;
        },
        {} as Record<string, { asset_id: string; amount: Decimal }>,
      ),
    );
  }

  private async calculateBalances(
    client: any,
    groupedUTXOs: { asset_id: string; amount: Decimal }[],
  ) {
    let totalUSDBalance = new Decimal(0);
    let totalBTCBalance = new Decimal(0);

    const balanceDetails = await Promise.all(
      groupedUTXOs.map(async ({ asset_id, amount }) => {
        const asset = await client.safe.fetchAsset(asset_id);

        const balanceUSD = this.calculateValueInCurrency(
          amount,
          asset.price_usd,
        );
        const balanceBTC = this.calculateValueInCurrency(
          amount,
          asset.price_btc,
        );

        totalUSDBalance = totalUSDBalance.plus(balanceUSD);
        totalBTCBalance = totalBTCBalance.plus(balanceBTC);

        return {
          asset: asset.asset_id,
          symbol: asset.symbol,
          balance: this.roundToPrecision(amount, 8),
          balanceUSD: this.roundToPrecision(balanceUSD, 2),
          balanceBTC: this.roundToPrecision(balanceBTC, 8),
        };
      }),
    );

    return {
      details: balanceDetails,
      totalUSD: totalUSDBalance,
      totalBTC: totalBTCBalance,
    };
  }

  private calculateValueInCurrency(
    amount: Decimal,
    price: string | number,
  ): Decimal {
    return amount.mul(new Decimal(price));
  }

  private roundToPrecision(value: Decimal, precision: number): string {
    return value
      .toDecimalPlaces(precision, Decimal.ROUND_HALF_UP)
      .toFixed(precision);
  }
}
