// Test setup file
process.env.NODE_ENV = 'test';

// Mock environment variables for tests
process.env.PORTFOLIO_URL = 'https://test.example.com/portfolio';
process.env.MAX_RETRIES = '2';
process.env.RETRY_DELAY_MS = '100';
process.env.PUPPETEER_HEADLESS = 'true';
process.env.SCHWAB_ENABLE_TRADING = 'false';
process.env.PORTFOLIO_SIZE = '10000';
