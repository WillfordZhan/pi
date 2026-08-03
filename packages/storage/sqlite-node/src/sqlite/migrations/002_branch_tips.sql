-- 迁移 002：为“分支缓存”引入 branch_tips 表。
-- 该表记录每个叶子条目（tip_id）当前对应的缓存分支（branch_id），
-- 使得追加新条目时能够快速定位到正确的分支并增量更新缓存。
CREATE TABLE IF NOT EXISTS branch_tips (
	session_id TEXT NOT NULL,
	tip_id TEXT NOT NULL,
	branch_id TEXT NOT NULL,
	PRIMARY KEY (session_id, tip_id),
	UNIQUE (session_id, branch_id)
) WITHOUT ROWID;

-- 分支缓存表结构在本次迁移中发生变化，因此重建时清空旧缓存数据，
-- 后续读取时若发现缓存无效会自动重建。
DELETE FROM branch_tips;
DELETE FROM branch_entries;

-- 移除旧版分支索引，由新的缓存实现按需重建。
DROP INDEX IF EXISTS idx_branch_entries_session_branch;
