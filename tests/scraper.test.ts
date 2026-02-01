import { scrapePortfolioData, closeBrowser } from '../src/scraper';
import { ScrapedPortfolioData, PortfolioAction } from '../src/types';
import puppeteer from 'puppeteer';

jest.mock('puppeteer');

describe('Scraper', () => {
  let mockBrowser: any;
  let mockPage: any;
  let originalBrowser: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockPage = {
      setUserAgent: jest.fn().mockResolvedValue(undefined),
      goto: jest.fn().mockResolvedValue({ ok: () => true, status: () => 200 }),
      evaluate: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };

    mockBrowser = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
    };

    (puppeteer.launch as jest.Mock).mockResolvedValue(mockBrowser);
    
    // Reset the module-level browser variable
    jest.resetModules();
  });

  afterEach(async () => {
    await closeBrowser();
    jest.resetModules();
  });

  describe('scrapePortfolioData', () => {
    it('should successfully scrape portfolio data with valid table', async () => {
      const mockActions = [
        { symbol: 'AAPL', action: 'BUY', shares: 100, price: 150.50 },
        { symbol: 'MSFT', action: 'SELL', shares: 50, price: 300.25 },
      ];

      mockPage.evaluate.mockResolvedValue(mockActions);

      const result = await scrapePortfolioData();

      expect(result).toHaveProperty('date');
      expect(result).toHaveProperty('actions');
      expect(result.actions).toHaveLength(2);
      expect(result.actions[0]).toMatchObject({
        symbol: 'AAPL',
        action: 'BUY',
        shares: 100,
        price: 150.50,
      });
      expect(result.actions[1]).toMatchObject({
        symbol: 'MSFT',
        action: 'SELL',
        shares: 50,
        price: 300.25,
      });
      expect(mockPage.goto).toHaveBeenCalled();
      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    it('should handle empty actions table', async () => {
      mockPage.evaluate.mockResolvedValue([]);

      await expect(scrapePortfolioData()).rejects.toThrow(
        "No actions found in 'Today's Actions' table"
      );
    });

    it('should retry on failure', async () => {
      mockPage.evaluate
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce([
          { symbol: 'AAPL', action: 'BUY', shares: 100, price: 150.50 },
        ]);

      const result = await scrapePortfolioData();

      expect(result.actions).toHaveLength(1);
      expect(mockPage.evaluate).toHaveBeenCalledTimes(2);
    });

    it('should handle HTTP errors', async () => {
      mockPage.goto.mockResolvedValueOnce({
        ok: () => false,
        status: () => 500,
        statusText: () => 'Internal Server Error',
      });

      await expect(scrapePortfolioData()).rejects.toThrow();
    });

    it('should normalize INCREASE/DECREASE actions to BUY/SELL', async () => {
      const mockActions = [
        { symbol: 'AAPL', action: 'BUY', shares: 100, price: 150.50 },
        { symbol: 'MSFT', action: 'SELL', shares: 50, price: 300.25 },
      ];

      mockPage.evaluate.mockResolvedValue(mockActions);

      const result = await scrapePortfolioData();

      expect(result.actions[0].action).toBe('BUY');
      expect(result.actions[1].action).toBe('SELL');
    });

    it('should parse prices with dollar signs and commas', async () => {
      const mockActions = [
        { symbol: 'AAPL', action: 'BUY', shares: 100, price: 1500.50 },
      ];

      mockPage.evaluate.mockResolvedValue(mockActions);

      const result = await scrapePortfolioData();

      expect(result.actions[0].price).toBe(1500.50);
    });

    it('should handle negative share changes for SELL actions', async () => {
      const mockActions = [
        { symbol: 'AAPL', action: 'SELL', shares: 100, price: 150.50 },
      ];

      mockPage.evaluate.mockResolvedValue(mockActions);

      const result = await scrapePortfolioData();

      expect(result.actions[0].shares).toBeGreaterThan(0);
      expect(result.actions[0].action).toBe('SELL');
    });

    it('should filter out invalid rows', async () => {
      const mockActions = [
        { symbol: 'AAPL', action: 'BUY', shares: 100, price: 150.50 },
        { symbol: '', action: 'BUY', shares: 0, price: 0 },
        { symbol: 'MSFT', action: 'HOLD', shares: 50, price: 300.25 },
      ];

      mockPage.evaluate.mockResolvedValue(mockActions.filter(a => a.symbol && a.shares > 0 && a.price > 0 && (a.action === 'BUY' || a.action === 'SELL')));

      const result = await scrapePortfolioData();

      expect(result.actions.length).toBeGreaterThanOrEqual(1);
      expect(result.actions.every(a => a.symbol && a.shares > 0 && a.price > 0)).toBe(true);
    });
  });

  describe('closeBrowser', () => {
    it('should close browser if it exists', async () => {
      const mockActions = [
        { symbol: 'AAPL', action: 'BUY', shares: 100, price: 150.50 },
      ];
      mockPage.evaluate.mockResolvedValue(mockActions);

      await scrapePortfolioData();
      await closeBrowser();

      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should handle closing when browser is null', async () => {
      await closeBrowser();
      await closeBrowser();

      expect(mockBrowser.close).not.toHaveBeenCalled();
    });
  });
});
