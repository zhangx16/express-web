import { closeDb, getSqlite } from './client.js';
import { migrate } from './migrate.js';

const ran = migrate();
const count = getSqlite().prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
if (ran.length > 0) {
  console.log(`已应用 ${ran.length} 个迁移: ${ran.join(', ')}`);
} else {
  console.log('数据库已是最新');
}
console.log(`迁移总数: ${count.n}`);
closeDb();
