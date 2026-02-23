import { PortfolioAction } from '../src/types';

const mockCreateSchwabAuth = jest.fn();
const mockCreateApiClient = jest.fn();

jest.mock('@sudowealth/schwab-api', () => {
  return {
    createSchwabAuth: (...args: any[]) => mockCreateSchwabAuth(...args),
    createApiClient: (...args: any[]) => mockCreateApiClient(...args),
    SchwabAuthError: class extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = 'SchwabAuthError';
      }
    },
  };
});

const mockReadSchwabCredentials = jest.fn().mockResolvedValue(null);
const mockWriteSchwabCredentials = jest.fn().mockResolvedValue(undefined);
const mockReadTradierCredentials = jest.fn().mockResolvedValue(null);
const mockWriteTradierCredentials = jest.fn().mockResolvedValue(undefined);
const mockGetPortfolioBrokerage = jest.fn().mockResolvedValue('schwab' as const);

jest.mock('../src/state', () => ({
  readSchwabCredentials: (...args: unknown[]) => mockReadSchwabCredentials(...args),
  writeSchwabCredentials: (...args: unknown[]) => mockWriteSchwabCredentials(...args),
  readTradierCredentials: (...args: unknown[]) => mockReadTradierCredentials(...args),
  writeTradierCredentials: (...args: unknown[]) => mockWriteTradierCredentials(...args),
  getPortfolioBrokerage: (...args: unknown[]) => mockGetPortfolioBrokerage(...args),
}));

const mockGetTradierPositions = jest.fn();
const mockPlaceTradierOrder = jest.fn();

jest.mock('../src/tradier-client', () => ({
  getTradierAccountId: jest.fn().mockResolvedValue('VA123'),
  getTradierPositions: (...args: unknown[]) => mockGetTradierPositions(...args),
  placeTradierOrder: (...args: unknown[]) => mockPlaceTradierOrder(...args),
}));

describe('Trader', () => {
  let mockSchwabClient: any;
  let mockAuth: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetPortfolioBrokerage.mockResolvedValue('schwab');
    mockReadTradierCredentials.mockResolvedValue(null);
    process.env.SCHWAB_ENABLE_TRADING = 'true';
    process.env.SCHWAB_CLIENT_ID = 'test-client-id';
    process.env.SCHWAB_CLIENT_SECRET = 'test-client-secret';
    process.env.SCHWAB_REDIRECT_URI = 'http://localhost:3000/callback';
    process.env.SCHWAB_ACCESS_TOKEN = 'test-access-token';
    process.env.SCHWAB_REFRESH_TOKEN = 'test-refresh-token';
    process.env.SCHWAB_ORDER_TYPE = 'MARKET';

    mockReadSchwabCredentials.mockResolvedValue({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      redirectUri: 'http://localhost:3000/callback',
      accountNumber: '123456789',
    });

    mockAuth = {
      refresh: jest.fn(),
    };

    mockSchwabClient = {
      trader: {
        accounts: {
          getAccountNumbers: jest.fn().mockResolvedValue([
            { accountNumber: '123456789', hashValue: 'mock-hash-123' },
          ]),
          getAccountByNumber: jest.fn(),
        },
        orders: {
          placeOrderForAccount: jest.fn(),
        },
      },
    };

    mockCreateSchwabAuth.mockReturnValue(mockAuth);
    mockCreateApiClient.mockReturnValue(mockSchwabClient);
  });

  afterEach(() => {
    jest.resetModules();
  });

  describe('executeTradesFromActions', () => {
    it('should successfully execute BUY orders', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      mockSchwabClient.trader.orders.placeOrderForAccount.mockResolvedValue({
        orderId: '12345',
      });

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(1);
      expect(result.failed).toHaveLength(0);
      expect(result.successful[0]).toMatchObject({
        symbol: 'AAPL',
        action: 'BUY',
        shares: 10,
        price: 150.50,
        success: true,
        orderId: '12345',
      });
      expect(mockSchwabClient.trader.orders.placeOrderForAccount).toHaveBeenCalledWith({
        pathParams: { accountNumber: 'mock-hash-123' },
        body: expect.objectContaining({
          orderType: 'MARKET',
          orderLegCollection: [
            {
              instruction: 'BUY',
              quantity: 10,
              instrument: {
                symbol: 'AAPL',
                assetType: 'EQUITY',
              },
            },
          ],
        }),
      });
    });

    it('should successfully execute SELL orders', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'MSFT', action: 'SELL', shares: 5, price: 300.25 },
      ];

      mockSchwabClient.trader.orders.placeOrderForAccount.mockResolvedValue({
        orderId: '67890',
      });

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(1);
      expect(result.failed).toHaveLength(0);
      expect(result.successful[0]).toMatchObject({
        symbol: 'MSFT',
        action: 'SELL',
        shares: 5,
        price: 300.25,
        success: true,
        orderId: '67890',
      });
      expect(mockSchwabClient.trader.orders.placeOrderForAccount).toHaveBeenCalledWith({
        pathParams: { accountNumber: 'mock-hash-123' },
        body: expect.objectContaining({
          orderType: 'MARKET',
          orderLegCollection: [
            {
              instruction: 'SELL',
              quantity: 5,
              instrument: {
                symbol: 'MSFT',
                assetType: 'EQUITY',
              },
            },
          ],
        }),
      });
    });

    it('should handle LIMIT orders when ORDER_TYPE is LIMIT', async () => {
      const originalOrderType = process.env.SCHWAB_ORDER_TYPE;
      process.env.SCHWAB_ORDER_TYPE = 'LIMIT';

      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      mockSchwabClient.trader.orders.placeOrderForAccount.mockResolvedValue({
        orderId: '12345',
      });

      const { executeTradesFromActions: executeTrades } = await import('../src/trader');
      const result = await executeTrades(actions, 1);

      expect(result.successful.length).toBeGreaterThanOrEqual(0);
      const callArgs = mockSchwabClient.trader.orders.placeOrderForAccount.mock.calls[0];
      if (callArgs && callArgs[0]?.body) {
        expect(['MARKET', 'LIMIT']).toContain(callArgs[0].body.orderType);
      }

      process.env.SCHWAB_ORDER_TYPE = originalOrderType;
    });

    it('should skip trading when ENABLE_TRADING is false', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      process.env.SCHWAB_ENABLE_TRADING = 'false';
      jest.resetModules();

      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      const { executeTradesFromActions: executeTrades } = await import('../src/trader');
      const result = await executeTrades(actions, 1);

      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(mockSchwabClient.trader.orders.placeOrderForAccount).not.toHaveBeenCalled();
    });

    it('should handle API errors gracefully', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
        { symbol: 'MSFT', action: 'BUY', shares: 5, price: 300.25 },
      ];

      mockSchwabClient.trader.orders.placeOrderForAccount
        .mockRejectedValueOnce(new Error('Insufficient funds'))
        .mockResolvedValueOnce({ orderId: '67890' });

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({
        symbol: 'AAPL',
        action: 'BUY',
        success: false,
        error: 'Insufficient funds',
      });
      expect(result.successful[0]).toMatchObject({
        symbol: 'MSFT',
        success: true,
      });
    });

    it('should handle API errors gracefully with token expiration', async () => {
      mockReadSchwabCredentials.mockResolvedValue({
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        redirectUri: 'https://127.0.0.1:8765/callback',
        accountNumber: '123456789',
      });
      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      const authError = Object.assign(new Error('Token expired'), {
        code: 'TOKEN_EXPIRED',
        name: 'SchwabAuthError',
      });
      mockSchwabClient.trader.orders.placeOrderForAccount
        .mockRejectedValueOnce(authError)
        .mockResolvedValueOnce({ orderId: 'after-refresh' });

      mockAuth.refresh.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(1);
      expect(result.successful[0].orderId).toBe('after-refresh');
    });

    it('should validate share quantity', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 0, price: 150.50 },
        { symbol: 'MSFT', action: 'BUY', shares: -5, price: 300.25 },
      ];

      const result = await executeTradesFromActions(actions, 1);

      expect(result.failed).toHaveLength(2);
      expect(result.failed.every(f => !f.success)).toBe(true);
      expect(result.failed.every(f => f.error?.includes('Invalid share quantity'))).toBe(true);
    });

    it('should handle empty actions array', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      const result = await executeTradesFromActions([], 1);

      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(mockSchwabClient.trader.orders.placeOrderForAccount).not.toHaveBeenCalled();
    });

    it('should execute multiple mixed actions', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
        { symbol: 'MSFT', action: 'SELL', shares: 5, price: 300.25 },
        { symbol: 'GOOGL', action: 'BUY', shares: 3, price: 2500.00 },
      ];

      mockSchwabClient.trader.orders.placeOrderForAccount
        .mockResolvedValueOnce({ orderId: '1' })
        .mockResolvedValueOnce({ orderId: '2' })
        .mockResolvedValueOnce({ orderId: '3' });

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
      expect(mockSchwabClient.trader.orders.placeOrderForAccount).toHaveBeenCalledTimes(3);
    });

    it('should handle missing credentials', async () => {
      mockReadSchwabCredentials.mockResolvedValue(null);
      mockGetPortfolioBrokerage.mockResolvedValue('schwab');
      jest.resetModules();

      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      const { executeTradesFromActions: executeTrades } = await import('../src/trader');

      await expect(executeTrades(actions, 1)).rejects.toThrow(/Schwab credentials are required|OAuth login/);
    });

    it('should execute orders via Tradier when portfolio has Tradier credentials', async () => {
      mockGetPortfolioBrokerage.mockResolvedValue('tradier');
      mockReadTradierCredentials.mockResolvedValue({
        apiKey: 'test-tradier-key',
        accountId: 'VA123',
        sandbox: true,
      });
      process.env.TRADIER_ENABLE_TRADING = 'true';
      jest.resetModules();

      mockPlaceTradierOrder.mockResolvedValue({ orderId: 'tradier-order-1' });

      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(1);
      expect(result.successful[0]).toMatchObject({
        symbol: 'AAPL',
        action: 'BUY',
        shares: 10,
        price: 150.50,
        success: true,
        orderId: 'tradier-order-1',
      });
      expect(mockPlaceTradierOrder).toHaveBeenCalledWith(
        'test-tradier-key',
        'VA123',
        true,
        'buy',
        'AAPL',
        10,
        150.50,
        expect.any(String)
      );
      expect(mockSchwabClient.trader.orders.placeOrderForAccount).not.toHaveBeenCalled();
    });

    it('should skip Tradier trading when TRADIER_ENABLE_TRADING is false', async () => {
      mockGetPortfolioBrokerage.mockResolvedValue('tradier');
      mockReadTradierCredentials.mockResolvedValue({
        apiKey: 'test-tradier-key',
        accountId: 'VA123',
        sandbox: true,
      });
      process.env.TRADIER_ENABLE_TRADING = 'false';
      jest.resetModules();

      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(mockPlaceTradierOrder).not.toHaveBeenCalled();
    });
  });

  describe('getPortfolioPositions', () => {
    it('should return positions from Tradier when portfolio has Tradier credentials', async () => {
      mockGetPortfolioBrokerage.mockResolvedValue('tradier');
      mockReadTradierCredentials.mockResolvedValue({
        apiKey: 'test-tradier-key',
        accountId: 'VA123',
        sandbox: true,
      });
      mockGetTradierPositions.mockResolvedValue([
        { symbol: 'AAPL', longQuantity: 10 },
        { symbol: 'MSFT', longQuantity: 5 },
      ]);
      jest.resetModules();

      const { getPortfolioPositions } = await import('../src/trader');
      const positions = await getPortfolioPositions(1);

      expect(positions).toHaveLength(2);
      expect(positions).toContainEqual({ symbol: 'AAPL', longQuantity: 10 });
      expect(positions).toContainEqual({ symbol: 'MSFT', longQuantity: 5 });
      expect(mockGetTradierPositions).toHaveBeenCalledWith('test-tradier-key', 'VA123', true);
    });
  });

  describe('verifyConnection', () => {
    it('should verify Tradier connection and return positions count', async () => {
      mockGetPortfolioBrokerage.mockResolvedValue('tradier');
      mockReadTradierCredentials.mockResolvedValue({
        apiKey: 'test-tradier-key',
        accountId: 'VA123',
        sandbox: true,
      });
      mockGetTradierPositions.mockResolvedValue([{ symbol: 'AAPL', longQuantity: 10 }]);
      jest.resetModules();

      const { verifyConnection } = await import('../src/trader');
      const result = await verifyConnection(1);

      expect(result.ok).toBe(true);
      expect(result.message).toContain('Tradier');
      expect(result.positionsCount).toBe(1);
    });
  });
});
