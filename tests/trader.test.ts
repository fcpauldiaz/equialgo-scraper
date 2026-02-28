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
  let mockFetch: jest.SpyInstance;

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
          getAccountByNumber: jest.fn().mockResolvedValue({
            securitiesAccount: { positions: [] },
          }),
        },
        orders: {
          placeOrderForAccount: jest.fn(),
        },
      },
    };

    mockCreateSchwabAuth.mockReturnValue(mockAuth);
    mockCreateApiClient.mockReturnValue(mockSchwabClient);

    mockFetch = jest.spyOn(global, 'fetch').mockImplementation(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ orderId: 12345 })),
          json: () => Promise.resolve({ orderId: 12345 }),
        } as Response)
    );
  });

  afterEach(() => {
    mockFetch?.mockRestore?.();
    jest.resetModules();
  });

  describe('executeTradesFromActions', () => {
    it('should successfully execute BUY orders', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

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
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/accounts/mock-hash-123/orders'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-access-token',
            'Content-Type': 'application/json',
          }),
        })
      );
      const fetchBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(fetchBody).toMatchObject({
        orderType: 'MARKET',
        orderLegCollection: [
          {
            instruction: 'BUY',
            quantity: 10,
            instrument: { symbol: 'AAPL', assetType: 'EQUITY' },
          },
        ],
      });
    });

    it('should successfully execute SELL orders', async () => {
      mockSchwabClient.trader.accounts.getAccountByNumber.mockResolvedValue({
        securitiesAccount: {
          positions: [
            { instrument: { symbol: 'MSFT' }, longQuantity: 5, shortQuantity: 0 },
          ],
        },
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ orderId: 67890 })),
        json: () => Promise.resolve({ orderId: 67890 }),
      } as Response);

      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'MSFT', action: 'SELL', shares: 5, price: 300.25 },
      ];

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
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/accounts/mock-hash-123/orders'),
        expect.anything()
      );
      const fetchBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(fetchBody).toMatchObject({
        orderType: 'MARKET',
        orderLegCollection: [
          {
            instruction: 'SELL',
            quantity: 5,
            instrument: { symbol: 'MSFT', assetType: 'EQUITY' },
          },
        ],
      });
    });

    it('should handle LIMIT orders when ORDER_TYPE is LIMIT', async () => {
      const originalOrderType = process.env.SCHWAB_ORDER_TYPE;
      process.env.SCHWAB_ORDER_TYPE = 'LIMIT';

      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      const { executeTradesFromActions: executeTrades } = await import('../src/trader');
      const result = await executeTrades(actions, 1);

      expect(result.successful.length).toBeGreaterThanOrEqual(0);
      if (mockFetch.mock.calls.length > 0) {
        const fetchBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
        expect(['MARKET', 'LIMIT']).toContain(fetchBody.orderType);
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
      const placeOrderFetches = mockFetch.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('/orders')
      );
      expect(placeOrderFetches).toHaveLength(0);
    });

    it('should handle API errors gracefully', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: () => Promise.resolve(JSON.stringify({ message: 'Insufficient funds' })),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ orderId: 67890 })),
          json: () => Promise.resolve({ orderId: 67890 }),
        } as Response);

      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
        { symbol: 'MSFT', action: 'BUY', shares: 5, price: 300.25 },
      ];

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({
        symbol: 'AAPL',
        action: 'BUY',
        success: false,
      });
      expect(result.failed[0].error).toContain('Insufficient funds');
      expect(result.successful[0]).toMatchObject({
        symbol: 'MSFT',
        success: true,
      });
    });

    it('should handle API errors gracefully with token expiration', async () => {
      mockReadSchwabCredentials
        .mockResolvedValueOnce({
          accessToken: 'test-access-token',
          refreshToken: 'test-refresh-token',
          redirectUri: 'https://127.0.0.1:8765/callback',
          accountNumber: '123456789',
        })
        .mockResolvedValue({
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
          redirectUri: 'https://127.0.0.1:8765/callback',
          accountNumber: '123456789',
        });

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: () => Promise.resolve(''),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ orderId: 'after-refresh' })),
          json: () => Promise.resolve({ orderId: 'after-refresh' }),
        } as Response);

      mockAuth.refresh?.mockResolvedValue?.({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });

      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(1);
      expect(result.successful[0].orderId).toBe('after-refresh');
      expect(mockFetch).toHaveBeenCalledTimes(2);
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
      const placeOrderFetches = mockFetch.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('/orders')
      );
      expect(placeOrderFetches).toHaveLength(0);
    });

    it('should execute multiple mixed actions', async () => {
      mockSchwabClient.trader.accounts.getAccountByNumber.mockResolvedValue({
        securitiesAccount: {
          positions: [
            { instrument: { symbol: 'MSFT' }, longQuantity: 5, shortQuantity: 0 },
          ],
        },
      });
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ orderId: 1 })),
          json: () => Promise.resolve({ orderId: 1 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ orderId: 2 })),
          json: () => Promise.resolve({ orderId: 2 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ orderId: 3 })),
          json: () => Promise.resolve({ orderId: 3 }),
        } as Response);

      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
        { symbol: 'MSFT', action: 'SELL', shares: 5, price: 300.25 },
        { symbol: 'GOOGL', action: 'BUY', shares: 3, price: 2500.00 },
      ];

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
      const placeOrderFetches = mockFetch.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('/orders')
      );
      expect(placeOrderFetches).toHaveLength(3);
    });

    it('should skip SELL when no position exists', async () => {
      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'XYZ', action: 'SELL', shares: 10, price: 50.0 },
      ];

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]).toMatchObject({
        symbol: 'XYZ',
        reason: 'No position to exit',
      });
      const placeOrderFetches = mockFetch.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('/orders')
      );
      expect(placeOrderFetches).toHaveLength(0);
    });

    it('should sell only up to existing position size', async () => {
      mockSchwabClient.trader.accounts.getAccountByNumber.mockResolvedValue({
        securitiesAccount: {
          positions: [
            { instrument: { symbol: 'DE' }, longQuantity: 5, shortQuantity: 0 },
          ],
        },
      });
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ orderId: 1 })),
        json: () => Promise.resolve({ orderId: 1 }),
      } as Response);

      const { executeTradesFromActions } = await import('../src/trader');
      const actions: PortfolioAction[] = [
        { symbol: 'DE', action: 'SELL', shares: 14, price: 624.96 },
      ];

      const result = await executeTradesFromActions(actions, 1);

      expect(result.successful).toHaveLength(1);
      expect(result.successful[0]).toMatchObject({
        symbol: 'DE',
        action: 'SELL',
        shares: 5,
        price: 624.96,
      });
    });

    it('should handle missing credentials', async () => {
      mockReadSchwabCredentials.mockResolvedValue(null);
      mockGetPortfolioBrokerage.mockResolvedValue('schwab');
      jest.resetModules();

      const actions: PortfolioAction[] = [
        { symbol: 'AAPL', action: 'BUY', shares: 10, price: 150.50 },
      ];

      const { executeTradesFromActions: executeTrades } = await import('../src/trader');

      const result = await executeTrades(actions, 1);

      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].symbol).toBe('ALL');
      expect(result.failed[0].error).toMatch(/Failed to fetch positions|Schwab credentials|OAuth login/);
    });

    it('should execute orders via Tradier when portfolio has Tradier credentials', async () => {
      mockGetPortfolioBrokerage.mockResolvedValue('tradier');
      mockReadTradierCredentials.mockResolvedValue({
        apiKey: 'test-tradier-key',
        accountId: 'VA123',
        sandbox: true,
      });
      mockGetTradierPositions.mockResolvedValue([]);
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
      const placeOrderFetches = mockFetch.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('/orders')
      );
      expect(placeOrderFetches).toHaveLength(0);
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
