import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GrpcEventSubscriber } from './path-to-your-subscriber';
import { DriftClient, parseLogs } from '@drift-labs/sdk';
import { RedisClient } from '@drift/common';
import {
	Client,
	SubscribeRequest,
	SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import { Connection, Keypair } from '@solana/web3.js';
import { ClientDuplexStream } from '@grpc/grpc-js';
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';

vi.mock('@drift-labs/sdk', () => ({
	DriftClient: vi.fn(),
	parseLogs: vi.fn(),
}));
vi.mock('@drift/common', () => ({
	RedisClient: vi.fn().mockImplementation(() => ({
		rPush: vi.fn(),
		publish: vi.fn(),
		connect: vi.fn(),
	})),
}));
vi.mock('@triton-one/yellowstone-grpc', () => ({
	Client: vi.fn().mockImplementation(() => ({
		subscribe: vi.fn().mockResolvedValue({
			on: vi.fn(),
			write: vi.fn(),
			end: vi.fn(),
			close: vi.fn(),
		}),
	})),
}));
vi.mock('@solana/web3.js', () => ({
	Connection: vi.fn(),
	Keypair: {
		generate: vi.fn(),
	},
}));
vi.mock('@coral-xyz/anchor/dist/cjs/utils/bytes', () => ({
	bs58: {
		encode: vi.fn(),
	},
}));

describe('GrpcEventSubscriber', () => {
	let driftClient;
	let redisClient;
	let config;
	let eventSubscriber;
	let mockStream;

	beforeEach(() => {
		driftClient = new DriftClient();
		redisClient = new RedisClient();
		config = {
			programId: 'program-id',
			endpoint: 'endpoint',
			token: 'token',
		};

		mockStream = {
			on: vi.fn(),
			write: vi.fn(),
			end: vi.fn(),
			close: vi.fn(),
		};

		Client.mockImplementationOnce(() => ({
			subscribe: vi.fn().mockResolvedValue(mockStream),
		}));

		eventSubscriber = new GrpcEventSubscriber(driftClient, redisClient, config);
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should subscribe to events', async () => {
		parseLogs.mockReturnValue([]);

		await eventSubscriber.subscribe();

		expect(Client).toHaveBeenCalledWith('endpoint', 'token');
		expect(mockStream.on).toHaveBeenCalledWith('data', expect.any(Function));
		expect(mockStream.on).toHaveBeenCalledWith('error', expect.any(Function));
		expect(mockStream.on).toHaveBeenCalledWith('end', expect.any(Function));
		expect(mockStream.on).toHaveBeenCalledWith('close', expect.any(Function));
		expect(mockStream.write).toHaveBeenCalledWith(
			expect.objectContaining({
				transactions: {
					drift: {
						vote: false,
						failed: false,
						accountInclude: ['program-id'],
						accountExclude: [],
						accountRequired: [],
					},
				},
				commitment: 1, // CommitmentLevel.CONFIRMED
			}),
			expect.any(Function)
		);
	});

	it('should handle data event', async () => {
		parseLogs.mockReturnValue([{ name: 'event', data: {} }]);
		const logMessages = ['log message'];
		const chunk = {
			transaction: {
				slot: 1,
				transaction: {
					meta: { logMessages },
					signature: new Uint8Array(),
				},
			},
		};

		bs58.encode.mockReturnValue('txSig');

		await eventSubscriber.subscribe();

		const dataHandler = mockStream.on.mock.calls.find(
			(call) => call[0] === 'data'
		)[1];
		dataHandler(chunk);

		expect(parseLogs).toHaveBeenCalledWith(driftClient.program, logMessages);
		expect(redisClient.rPush).toHaveBeenCalledWith(
			'event',
			JSON.stringify({
				txSig: 'txSig',
				slot: 1,
				eventType: 'event',
				txSigIndex: 0,
			})
		);
		expect(redisClient.publish).toHaveBeenCalledWith('event', {
			txSig: 'txSig',
			slot: 1,
			eventType: 'event',
			txSigIndex: 0,
		});
	});

	it('should handle error event', async () => {
		await eventSubscriber.subscribe();

		const errorHandler = mockStream.on.mock.calls.find(
			(call) => call[0] === 'error'
		)[1];
		errorHandler(new Error('stream error'));

		expect(mockStream.end).toHaveBeenCalled();
	});

	it('should handle end event', async () => {
		await eventSubscriber.subscribe();

		const endHandler = mockStream.on.mock.calls.find(
			(call) => call[0] === 'end'
		)[1];
		endHandler();

		expect(console.log).toHaveBeenCalledWith('the stream ended');
	});

	it('should handle close event', async () => {
		await eventSubscriber.subscribe();

		const closeHandler = mockStream.on.mock.calls.find(
			(call) => call[0] === 'close'
		)[1];
		closeHandler();

		expect(console.log).toHaveBeenCalledWith('the stream closed');
	});

	it('should unsubscribe from events', async () => {
		eventSubscriber.stream = mockStream;

		await eventSubscriber.unsubscribe();

		expect(mockStream.write).toHaveBeenCalledWith(
			expect.objectContaining({
				slots: {},
				accounts: {},
				transactions: {},
				blocks: {},
				blocksMeta: {},
				accountsDataSlice: [],
				entry: {},
			}),
			expect.any(Function)
		);
	});
});
