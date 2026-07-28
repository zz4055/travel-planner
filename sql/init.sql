SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS plan_records (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  trip_name VARCHAR(120) NOT NULL DEFAULT '',
  destination VARCHAR(80) NOT NULL,
  start_date VARCHAR(20) NOT NULL DEFAULT '',
  end_date VARCHAR(20) NOT NULL DEFAULT '',
  days_label VARCHAR(40) NOT NULL DEFAULT '',
  preferences_json JSON NOT NULL,
  pace VARCHAR(30) NOT NULL DEFAULT '均衡',
  advice_json JSON NOT NULL,
  plan_json JSON NOT NULL,
  answer_source VARCHAR(20) NOT NULL DEFAULT 'deepseek',
  model VARCHAR(80) NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_plan_created (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
