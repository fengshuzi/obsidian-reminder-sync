# Obsidian 提醒事项记账同步

从 macOS 提醒事项读取带有记账标签的提醒，自动同步到对应日期的日记笔记。

## 功能特性

- 🔄 从 macOS 提醒事项读取记账信息
- 📅 根据提醒的到期日期自动同步到对应日记
- 💰 支持与 obsidian-accounting 相同的记账关键词
- ⚡ 支持手动同步和自动定时同步
- 🔍 预览待同步的提醒事项

## 使用方法

### 1. 在提醒事项中添加记账

在 macOS 提醒事项中创建提醒，标题格式：

```
💰cy 50 午餐
💰jt 20 地铁
💰sr 5000 工资
```

格式说明：
- `💰` - 记账标识符（必需）
- `cy/jt/sr` - 记账关键词（必需）
- `50/20/5000` - 金额（必需）
- `午餐/地铁/工资` - 描述（可选）

### 2. 设置到期日期

为提醒设置到期日期，插件会将记账记录同步到对应日期的日记文件。

### 3. 同步到日记

使用命令面板（Cmd+P）执行：
- `同步提醒事项到日记` - 立即同步
- `预览待同步的提醒事项` - 查看待同步内容

## 支持的记账关键词

| 关键词 | 分类 |
|--------|------|
| cy | 餐饮 |
| jt | 交通 |
| yl | 娱乐 |
| gw | 购物 |
| yy | 医疗 |
| jy | 教育 |
| fz | 房租 |
| qt | 其他 |
| sr | 收入 |

## 配置说明

编辑 `config.json` 文件：

```json
{
    "appName": "提醒事项记账同步",
    "categories": {
        "cy": "餐饮",
        "jt": "交通",
        ...
    },
    "expenseEmoji": "💰",
    "journalsPath": "journals",
    "reminderListName": "Inbox",
    "autoSync": false,
    "syncInterval": 300000
}
```

- `journalsPath` - 日记文件夹路径
- `reminderListName` - 提醒事项列表名称
- `autoSync` - 是否启用自动同步
- `syncInterval` - 自动同步间隔（毫秒）

## 系统要求

- macOS 系统
- Obsidian 1.2.8+
- 需要访问 macOS 提醒事项的权限

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 部署到 vault
npm run deploy

# 发布版本
npm run release
```

## 许可证

MIT
