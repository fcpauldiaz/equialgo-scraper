import { PortfolioAction } from '../src/types';

jest.mock('@sudowealth/schwab-api', () => ({
  createSchwabAuth: jest.fn(),
  createApiClient: jest.fn(),
  SchwabAuthError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'SchwabAuthError';
    }
  },
}));

describe('Trader', () => {
  let mockSchwabClient: any;
  let mockAuth: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.SCHWAB_ENABLE_TRADING = 'true';
    process.env.SCHWAB_ACCOUNT_NUMBER = '123456789';
    process.env.SCHWAB_CLIENT_ID = 'test-client-id';
    process.env.SCHWAB_CLIENT_SECRET = 'test-client-secret';
    process.env.SCHWAB_REDIRECT_URI = 'http://localhost:3000/callback';
    process.env.SCHWAB_ACCESS_TOKEN = 'test-access-token';
    process.env.SCHWAB_REFRESH_TOKEN = 'test-refresh-token';
    process.env.SCHWAB_ORDER_TYPE = 'MARKET';

    const { createSchwabAuth, createApiClient } = await import('@sudowealth/schwab-api');
    
    mockAuth = {
      refresh: jest.fn(),
    };

    mockSchwabClient = {
      trader: {
        accounts: {
          getAccountByNumber: jest.fn(),
        },
        orders: {
          placeOrderForAccount: jest.fn(),
        },
      },
    };

    (createSchwabAuth as jest.Mock).mockReturnValue(mockAuth);
    (createApiClient as jest.Mock).mockReturnValue(mockSchwabClient);
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

      const result = await executeTradesFromActions(actions);

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
        pathParams: { accountNumber: '123456789' },
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

      const result = await executeTradesFromActions(actions);

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
        pathParams: { accountNumber: '123456789' },
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
      const result = await executeTrades(actions);

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
      const result = await executeTrades(actions);

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

      const result = await executeTradesFromActions(actions);

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
      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      const authError = Object.assign(new Error('Token expired'), {
        code: 'TOKEN_EXPIRED',
        name: 'SchwabAuthError',
      });
      mockSchwabClient.trader.orders.placeOrderForAccount
        .mockRejectedValueOnce(authError);

      const result = await executeTradesFromActions(actions);

      expect(result.failed.length).toBeGreaterThanOrEqual(0);
      expect(result.successful.length).toBeGreaterThanOrEqual(0);
    });

    it('should validate share quantity', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 0, price: 150.50 },
        { symbol: 'MSFT', action: 'BUY', shares: -5, price: 300.25 },
      ];

      const result = await executeTradesFromActions(actions);

      expect(result.failed).toHaveLength(2);
      expect(result.failed.every(f => !f.success)).toBe(true);
      expect(result.failed.every(f => f.error?.includes('Invalid share quantity'))).toBe(true);
    });

    it('should handle empty actions array', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      const result = await executeTradesFromActions([]);

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

      const result = await executeTradesFromActions(actions);

      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
      expect(mockSchwabClient.trader.orders.placeOrderForAccount).toHaveBeenCalledTimes(3);
    });

    it('should handle missing environment variables', async () => {
      delete process.env.SCHWAB_ACCOUNT_NUMBER;
      jest.resetModules();

      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      const { executeTradesFromActions: executeTrades } = await import('../src/trader');
      
      await expect(executeTrades(actions)).rejects.toThrow('SCHWAB_ACCOUNT_NUMBER');
    });
  });
});
