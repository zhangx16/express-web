DELETE FROM settings WHERE key IN ('aiBaseUrl', 'aiModel', 'aiPersona', 'aiSystemPrompt');
DELETE FROM secrets WHERE name = 'ai_api_key';
