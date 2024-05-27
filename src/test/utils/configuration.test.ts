import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigurationService } from '../../utils/configuration';
import { RedisClient } from '@drift/common';

vi.mock('uuid', () => ({
	v4: vi.fn().mockReturnValue('mock-uuid'),
}));


const mockRedisClient = {
	rPush: vi.fn(),
	lRange: vi.fn(),
	lRem: vi.fn(),
	del: vi.fn(),
	subscribe: vi.fn(),
	forceGetClient: vi.fn().mockReturnThis(),
	on: vi.fn(),
	lset: vi.fn(),
	publish: vi.fn(),
};

describe('ConfigurationService', () => {
	let service;
	
	beforeEach(() => {
		service = ConfigurationService(mockRedisClient as unknown as RedisClient);
		vi.useFakeTimers( { shouldAdvanceTime: true});
		vi.clearAllMocks();
	});

	it('should setup the client and check promotion', async () => {
		console.log(service)
		const spyOn = vi.spyOn(service, 'checkIfShouldPromote').mockImplementation(() => console.log('do nothign'))
		await service.setupClient();
		expect(mockRedisClient.rPush).toHaveBeenCalledWith(
			'events-publisher-config',
			JSON.stringify({ id: 'mock-uuid' })
		);
		vi.advanceTimersByTime(1000);
		expect(spyOn).not.toBeCalled();	
		await vi.advanceTimersByTime(5001);
		expect(spyOn).toBeCalled()
	});

	// it('should remove the client from the list and handle promotion', async () => {
	// 	mockRedisClient.lRange.mockResolvedValueOnce([
	// 		JSON.stringify({ id: CLIENT }),
	// 		JSON.stringify({ id: 'another-client-id' }),
	// 	]);
	// 	mockRedisClient.lRem.mockResolvedValueOnce(1);

	// 	await service.shutdown();

	// 	expect(mockRedisClient.lRange).toHaveBeenCalledWith(
	// 		REDIS_CONFIG_KEY,
	// 		0,
	// 		-1
	// 	);
	// 	expect(mockRedisClient.lRem).toHaveBeenCalledWith(
	// 		REDIS_CONFIG_KEY,
	// 		1,
	// 		JSON.stringify({ id: CLIENT })
	// 	);
	// });

	// it('should delete the key if only one client remains', async () => {
	// 	mockRedisClient.lRange.mockResolvedValueOnce([
	// 		JSON.stringify({ id: CLIENT }),
	// 	]);

	// 	await service.shutdown();

	// 	expect(mockRedisClient.lRange).toHaveBeenCalledWith(
	// 		REDIS_CONFIG_KEY,
	// 		0,
	// 		-1
	// 	);
	// 	expect(mockRedisClient.del).toHaveBeenCalledWith(REDIS_CONFIG_KEY);
	// });

	// it('should not remove if client not found', async () => {
	// 	mockRedisClient.lRange.mockResolvedValueOnce([
	// 		JSON.stringify({ id: 'another-client-id' }),
	// 	]);

	// 	await service.shutdown();

	// 	expect(mockRedisClient.lRange).toHaveBeenCalledWith(
	// 		REDIS_CONFIG_KEY,
	// 		0,
	// 		-1
	// 	);
	// 	expect(mockRedisClient.lRem).not.toHaveBeenCalled();
	// 	expect(mockRedisClient.del).not.toHaveBeenCalled();
	// });

	// it('should await promotion and call callback', async () => {
	// 	const callback = vi.fn();
	// 	const message = JSON.stringify({ isWriting: true });

	// 	mockRedisClient.subscribe.mockResolvedValueOnce(1);
	// 	mockRedisClient.on.mockImplementation((event, handler) => {
	// 		if (event === 'message') {
	// 			handler(REDIS_CLIENT_CHANNEL, message);
	// 		}
	// 	});

	// 	await service.awaitPromotion({ callback });

	// 	expect(mockRedisClient.subscribe).toHaveBeenCalledWith(
	// 		REDIS_CLIENT_CHANNEL
	// 	);
	// 	expect(callback).toHaveBeenCalled();
	// });

	// it('should check if should promote and promote if no client is writing', async () => {
	// 	const promoteSpy = vi.spyOn(service, 'promote');
	// 	mockRedisClient.lRange.mockResolvedValueOnce([
	// 		JSON.stringify({ id: CLIENT }),
	// 	]);

	// 	vi.useFakeTimers();
	// 	await service.checkIfShouldPromote();
	// 	vi.runAllTimers();

	// 	expect(mockRedisClient.lRange).toHaveBeenCalledWith(
	// 		REDIS_CONFIG_KEY,
	// 		0,
	// 		-1
	// 	);
	// 	expect(promoteSpy).toHaveBeenCalled();
	// });

	// it('should promote a client', async () => {
	// 	mockRedisClient.lRange.mockResolvedValueOnce([
	// 		JSON.stringify({ id: CLIENT }),
	// 	]);

	// 	await service.promote();

	// 	const payload = { id: CLIENT, isWriting: true };

	// 	expect(mockRedisClient.lset).toHaveBeenCalledWith(
	// 		REDIS_CONFIG_KEY,
	// 		0,
	// 		JSON.stringify(payload)
	// 	);
	// 	expect(mockRedisClient.publish).toHaveBeenCalledWith(
	// 		REDIS_CLIENT_CHANNEL,
	// 		JSON.stringify(payload)
	// 	);
	// });
});
