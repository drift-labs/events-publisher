import { describe, it, beforeEach, vi, expect } from 'vitest';
import { main } from '..';

vi.mock('@drift-labs/sdk', () => {
	return {
		DriftClient: vi.fn().mockImplementation(() => ({
			program: {
				programId: {
					toString: () => 'test',
				},
			},
		})),
		Wallet: vi.fn(),
	};
});

vi.mock('@drift/common', () => {
	return {
		RedisClient: vi.fn(() => ({
			connect: vi.fn(),
			rPush: vi.fn(),
			publish: vi.fn(),
		})),
		logger: {
			alert: vi.fn(),
			error: vi.fn(),
		},
	};
});


const mockSetup = vi.fn();
const mockShutdown = vi.fn();
let mockAwaitPromotion = vi.fn();

vi.mock('../utils/configuration', async (importOriginal) => {
    const actualModule = await importOriginal<typeof import('../utils/configuration')>();
	return {
		ConfigurationService: vi.fn(() => ({
            ...actualModule.ConfigurationService,
			setupClient: mockSetup,
			awaitPromotion: mockAwaitPromotion,
			shutdown: mockShutdown,
		})),
	};
});

describe('main function', () => {
	it('should handle startup correctly', async () => {
		await main();
		expect(mockSetup).toHaveBeenCalled();
		expect(mockAwaitPromotion).toHaveBeenCalled();
	});

	it('should handle errors during awaitPromotion', async () => {
		const error = new Error('Test error');
		mockAwaitPromotion = vi.fn().mockRejectedValue(error);

		try {
			await main();
		} catch (error) {
			// Ignore for assertions
		}

		expect(mockSetup).toHaveBeenCalled();
		expect(mockAwaitPromotion).toHaveBeenCalled();
		expect(mockShutdown).toHaveBeenCalled();
	});
});
