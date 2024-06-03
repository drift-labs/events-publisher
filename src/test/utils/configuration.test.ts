import {
	describe,
	it,
	expect,
	beforeEach,
	vi,
	afterEach,
	Mocked,
} from 'vitest';
import { ConfigurationService } from '../../utils/configuration';
import { RedisClient, Logger } from '@drift/common';

vi.mock('@drift/common');

vi.mock('uuid', () => ({
	v4: vi.fn().mockReturnValue('mock-uuid'),
}));

describe('ConfigurationService', () => {
	let redisClient: Mocked<RedisClient>;
	let logger: Mocked<Logger>;
	let service: ReturnType<typeof ConfigurationService>;

	beforeEach(() => {
		redisClient = {
			rPush: vi.fn(),
			lRem: vi.fn(),
			delete: vi.fn(),
			subscribe: vi.fn(),
			publish: vi.fn(),
			forceGetClient: vi.fn().mockReturnValue({
				on: vi.fn(),
				lset: vi.fn(),
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
	});

	describe('setupClient', () => {
		it('should setup the client', async () => {
			redisClient.rPush.mockResolvedValue(null);
			await service.setupClient();
			expect(redisClient.rPush).toHaveBeenCalledWith(
				'events-publisher-config',
				'{\"id\":\"mock-uuid\"}'
			);
			expect(redisClient.subscribe).toHaveBeenCalledWith(expect.any(String));
		});
	});

	describe('shutdown', () => {
		it('should shutdown the client and promote if necessary', async () => {
			redisClient.lRange.mockResolvedValue(
				[JSON.stringify({ id: 'mock-uuid', isWriting: true }), JSON.stringify({ id: 'mock-uuid-2' })],
			);
			await service.shutdown();
			expect(redisClient.lRem).toHaveBeenCalledWith(
				'events-publisher-config',
				1,
				"{\"id\":\"mock-uuid\",\"isWriting\":true}"
			);
		});

		it('should delete the key if only one client remaining', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid', isWriting: true }),
			]);
			await service.shutdown();
			expect(redisClient.delete).toHaveBeenCalledWith(
				'events-publisher-config',
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
			const callback = vi.fn();
			await service.awaitPromotion({ callback });
			const messageHandler = redisClient
				.forceGetClient()
				// @ts-ignore
				.on.mock.calls.find((call) => call[0] === 'message')[1];
			messageHandler('events-client-mock-uuid', JSON.stringify({ isWriting: true }));
			expect(callback).toHaveBeenCalled();
		});
	});

	describe('checkIfShouldPromote', () => {
		it('should not promote if client is writing', async () => {
			redisClient.lRange.mockResolvedValue([JSON.stringify({ id: 'mock-uuid-2', isWriting: true }), JSON.stringify({ id: 'mock-uuid-3' })]);
			await service.checkIfShouldPromote();
			expect(redisClient.forceGetClient().lset).not.toHaveBeenCalled();
		});

		it('should promote if no client is writing', async () => {
			redisClient.lRange.mockResolvedValue([JSON.stringify({ id: 'mock-uuid-2' }), JSON.stringify({ id: 'mock-uuid-3' })]);
			await service.checkIfShouldPromote();
			expect(redisClient.forceGetClient().lset).toHaveBeenCalled();
			expect(redisClient.publish).toHaveBeenCalledWith('events-client-mock-uuid-2', { id: 'mock-uuid-2', isWriting: true});
		});
	});

	describe('checkIfClientsConnected', () => {
		it('should check clients and clean up stale connections', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-uuid-2-inactive' }),
				JSON.stringify({ id: 'mock-uuid-3-inactive' }),
			]);
			vi.useFakeTimers();
			await service.checkIfClientsConnected();
			vi.runAllTimers();
			expect(redisClient.publish).toHaveBeenCalledTimes(2)
			expect(redisClient.publish).toHaveBeenCalledWith('events-client', { id: 'mock-uuid-3-inactive', ping: true});
			expect(redisClient.lRem).toHaveBeenCalledTimes(2);
		});
	});

	describe('promote', () => {
		it('should promote the first client', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'mock-client-id' }),
			]);
			await service.promote();
			expect(redisClient.forceGetClient().lset).toHaveBeenCalled();
			expect(redisClient.publish).toHaveBeenCalledWith('events-client-mock-client-id', {
				id: 'mock-client-id',
				isWriting: true
			});
		});

		it('should throw an error if no clients are found', async () => {
			redisClient.lRange.mockResolvedValue([]);
			await expect(service.promote()).rejects.toThrow(
				'Failed promoting a client: Unable to find client'
			);
		});
	});

	describe('getClients', () => {
		it('should get clients from Redis', async () => {
			redisClient.lRange.mockResolvedValue([
				JSON.stringify({ id: 'client1' }),
			]);
			const clients = await service.getClients();
			expect(clients).toEqual([{ id: 'client1' }]);
		});
	});
});
