import {
	describe,
	it,
	expect,
	beforeEach,
	vi,
	afterEach,
	Mocked,
} from 'vitest';
import { ConfigurationService } from '../../services/configuration';
import { RedisClient, Logger } from '@drift/common';

vi.mock('@drift/common');

vi.mock('uuid', () => ({
	v4: vi.fn().mockReturnValue('mock-uuid'),
}));

describe('ConfigurationService', () => {
	let redisClient: Mocked<RedisClient>;
	let logger: Mocked<Logger>;
	let service: ReturnType<typeof ConfigurationService>;
	const timestamp = 1670994900000;

	beforeEach(() => {
		vi.spyOn(Date, 'now').mockReturnValue(1670994900000);

		redisClient = {
			rPush: vi.fn(),
			lRem: vi.fn(),
			delete: vi.fn(),
			subscribe: vi.fn(),
			publish: vi.fn(),
			lSet: vi.fn(),
			forceGetClient: vi.fn().mockReturnValue({
				on: vi.fn(),
			}),
			lRange: vi.fn(),
		} as any;
		logger = {
			info: vi.fn(),
			alert: vi.fn(),
		} as any;
		service = ConfigurationService(redisClient, logger);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('setupClient', () => {
		it('should setup the client', async () => {
			redisClient.rPush.mockResolvedValue(null);
			vi.useFakeTimers();
			await service.setupClient();
			expect(redisClient.rPush).toHaveBeenCalledWith(
				'events-publisher-config',
				'{"id":"mock-uuid","freshness":1670994900000}'
			);
		});
	});

	describe('shutdown', () => {
		it('should shutdown the client and promote if necessary', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid', isWriting: true }),
				JSON.stringify({ id: 'mock-uuid-2' }),
			]);
			await service.shutdown();
			expect(redisClient.lRem).toHaveBeenCalledWith(
				'events-publisher-config',
				1,
				'{"id":"mock-uuid","isWriting":true}'
			);
		});

		it('should delete the key if only one client remaining', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid', isWriting: true }),
			]);
			await service.shutdown();
			expect(redisClient.delete).toHaveBeenCalledWith(
				'events-publisher-config'
			);
		});

		it('should handle errors gracefully', async () => {
			const error = new Error('Test Error');
			redisClient.lRange.mockRejectedValueOnce(error);
			await service.shutdown();
			expect(logger.alert).toHaveBeenCalledWith(
				`Failed to shutdown gracefully: ${error.message}`
			);
		});
	});

	describe('awaitPromotion', () => {
		it('should handle promotion', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid', isWriting: true }),
			]);

			const callback = vi.fn();
			const clearSpy = vi.spyOn(global, 'clearInterval');

			vi.useRealTimers();
			await service.awaitPromotion({ callback });
			// Mock waiting for the timer
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(callback).toHaveBeenCalled();
			expect(clearSpy).toHaveBeenCalled();
		});
	});

	describe('checkIfShouldPromote', () => {
		it('should not promote if client is writing', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid-2', isWriting: true }),
				JSON.stringify({ id: 'mock-uuid-3' }),
			]);
			await service.checkIfShouldPromote();
			expect(redisClient.lSet).not.toHaveBeenCalled();
		});

		it('should promote if no client is writing', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid-2' }),
				JSON.stringify({ id: 'mock-uuid-3' }),
			]);
			await service.checkIfShouldPromote();
			expect(redisClient.lSet).toHaveBeenCalled();
		});
	});

	describe('checkConnectedClients', () => {
		it('should check clients and clean up stale connections', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({
					id: 'mock-uuid-2-inactive',
					freshness: 1670994898499,
				}),
				JSON.stringify({
					id: 'mock-uuid-2-inactive',
					freshness: 1670994898500,
				}),
				JSON.stringify({ id: 'mock-uuid-3-inactive' }),
			]);
			vi.useFakeTimers();
			await service.checkConnectedClients();
			vi.runAllTimers();
			expect(redisClient.lRem).toHaveBeenCalledTimes(2);
		});
	});

	describe('checkIfMultipleWriteClients', () => {
		it('should check to see if there are two writers', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid', isWriting: true }),
				JSON.stringify({ id: 'mock-uuid-3-inactive', isWriting: true }),
			]);

			await expect(service.checkIfMultipleWriteClients()).rejects.toThrow(
				'Failing over client due to duplicate writers'
			);
		});

		it('should only throw an error on the client', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid-2-inactive', isWriting: true }),
				JSON.stringify({ id: 'mock-uuid-3-inactive', isWriting: true }),
			]);
			await expect(
				service.checkIfMultipleWriteClients()
			).resolves.toBeUndefined();
		});
	});

	describe('updateFreshness', async () => {
		it('should update the freshness value of the client', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid-2' }),
				JSON.stringify({ id: 'mock-uuid' }),
			]);
			await service.updateFreshness();
			expect(redisClient.lSet).toHaveBeenCalledWith(
				'events-publisher-config',
				1,
				'{"id":"mock-uuid","freshness":1670994900000}'
			);
		});
	});

	describe('promote', () => {
		it('should promote the first client', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-client-id' }),
			]);
			await service.promote();
			expect(redisClient.lSet).toHaveBeenCalledWith(
				'events-publisher-config',
				0,
				'{"id":"mock-client-id","isWriting":true}'
			);
		});

		it('should throw an error if no clients are found', async () => {
			redisClient.lRange.mockResolvedValue([]);
			await expect(service.promote()).rejects.toThrow(
				'Failed promoting a client: No client exists'
			);
		});
	});

	describe('getClients', () => {
		it('should get clients from Redis', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid' }),
				JSON.stringify({ id: 'mock-uuid-2' }),
			]);
			const clients = await service.getClients();
			expect(clients).toEqual([{ id: 'mock-uuid' }, { id: 'mock-uuid-2' }]);
		});
	});

	describe('getClient', () => {
		it('should get client from Redis', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid' }),
				JSON.stringify({ id: 'mock-uuid-1' }),
			]);
			const clients = await service.getClient();
			expect(clients).toEqual({ id: 'mock-uuid' });
		});
	});
});
