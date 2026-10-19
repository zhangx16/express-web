import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 测试不启动调度器/浏览器，也不读写生产 DATA_DIR
    env: {
      NODE_ENV: 'test',
      DATA_DIR: '/tmp/expressassistant-test',
      DISABLE_SCHEDULER: '1',
      DISABLE_BROWSER: '1',
      // 测试主密钥固定落在临时目录，绝不触碰生产 /etc
      MASTER_KEY_FILE: '/tmp/expressassistant-test/master.key',
    },
  },
});
