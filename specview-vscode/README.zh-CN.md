# SpecView - 音频频谱图查看器 (VS Code 扩展)

[English](https://github.com/RicherMans/SpecView/blob/main/specview-vscode/README.md)

一款用于查看音频频谱图的 VS Code 扩展，支持音频播放、自动分组 A/B 对比，以及基于机器学习的音频分类。

基于 [SpecView](https://github.com/RicherMans/SpecView)（作者：Heinrich）。

## 功能介绍

### 频谱图可视化

打开任意音频文件即可查看其频谱图，使用热力色彩（hot-metal colormap）渲染。频谱图旁边显示频率标签和时间标尺，便于参考。

支持的音频格式：**WAV、MP3、OGG、FLAC、M4A、AAC、WebM、WMA、AIFF、Opus**。

### 音频播放

- **播放 / 暂停 / 停止** 控制按钮位于工具栏
- **点击频谱图** 可跳转到任意位置（保留播放状态）
- **音量控制** 滑块
- 实时播放头追踪与时间显示
- **自动暂停**：切换到其他 VS Code 面板或标签页时自动暂停播放

### 时域波形显示

通过工具栏的 **Waveform** 复选框开启，可在每个频谱图上方显示时域振幅包络。

- 左侧纵坐标显示振幅标签（-1.0、0、1.0）
- 波形 canvas 与频谱图时间对齐，点击、缩放、seek 操作两者同步
- 每像素列以 min/max 竖线展示振幅包络
- 波形播放头与频谱播放头同步
- Ctrl+滚轮和 Shift+拖拽在波形和频谱上均生效

### 时间轴缩放

支持对频谱图进行时间轴缩放，便于细节查看：

- **Ctrl + 鼠标滚轮**：以鼠标位置为中心缩放
- **鼠标滚轮**（缩放状态下）：水平滚动平移可见区间
- **Shift + 鼠标拖拽**：框选一个时间区间并放大显示
- **工具栏 + / – / Fit**：放大、缩小、重置为全部显示
- **键盘快捷键**：`Shift+↑`（放大）、`Shift+↓`（缩小）、`Shift+←`（重置）
- **分组联动**：同一 diff group 内的所有轨道同步缩放和滚动
- 播放头超出可见区间时自动隐藏
- STFT 仅计算一次并缓存，缩放和滚动操作即时响应

### 自动分组 A/B 对比

文件名相同（基名匹配）且带有已知标签后缀的文件，会被自动分组并排显示，方便 A/B 对比。使用 **Shift + Space** 可在分组内的轨道间即时切换，同时保持播放位置不变。

#### 已识别的分组标签

以下标签在作为后缀（如 `file1_pred.wav`）或前缀（如 `pred_file1.wav`）使用时，会触发自动分组。分隔符支持 `_` 和 `-`：

| 类别 | 标签 |
|---|---|
| **原始 / 参考** | `orig`、`original`、`ref`、`reference`、`gt`、`ground_truth`、`target` |
| **生成 / 预测** | `pred`、`predicted`、`gen`、`generated`、`synth`、`synthesized`、`output` |
| **处理** | `recon`、`reconstructed`、`enhanced`、`denoised`、`clean`、`noisy` |
| **输入 / 来源** | `src`、`source`、`input`、`baseline`、`model` |
| **版本 / 标记** | `v1`、`v2`、`v3`、`v4`、`a`、`b`、`c`、`d` |

#### 分组示例

| 文件 | 是否分组 | 原因 |
|---|---|---|
| `song_pred.wav` + `song_orig.wav` | 是 | 基名=`song`，标签=`pred`+`orig` |
| `song.wav` + `song_pred.wav` | 是 | 基名=`song`，标签=(空)+`pred` |
| `pred-song.wav` + `orig-song.wav` | 是 | 前缀模式，基名=`song` |
| `file1_ground_truth.wav` + `file1.wav` | 是 | 最长匹配：`ground_truth` |
| `/exp1/file1.wav` + `/exp2/file1.wav` | 是 | 同名不同目录，标签=`exp1`+`exp2` |
| `my_song.wav` + `my_voice.wav` | 否 | `song` 和 `voice` 不在标签列表中 |
| `file1_xxx.wav` | 否 | `xxx` 不在标签列表中 |

#### 分组规则

- 标签匹配 **不区分大小写**，最长匹配优先
- 同时支持 **后缀**（`基名_标签`）和 **前缀**（`标签_基名`）两种模式
- 当同一基名下有 **2 个及以上文件**，且有 **2 个及以上不同的标签**（空标签也算一种）时，才会形成分组
- 不同目录下的同名文件会自动分组，标签显示为所在目录名
- 重复文件（相同路径）会被自动跳过

### ML 音频分类

点击 **Analyze** 按钮，即可使用 [CED-tiny](https://huggingface.co/mispeech/ced-tiny) ONNX 模型在本地运行音频分类，可识别 527 种 AudioSet 声音类别。

三个层级的分析功能：

| 按钮 | 位置 | 作用范围 |
|---|---|---|
| **Analyze All** | 工具栏 | 所有已加载的轨道 |
| **Analyze Group** | 分组卡片头部 | 当前分组内所有轨道 |
| **Analyze** | 单个轨道 / Lane 标签 | 单个轨道 |

模型在首次使用时下载（约 20MB），之后会被缓存以供后续分析使用。检测结果以彩色标签显示在每个频谱图下方，包含检测到的声音类别、时间区间和置信度。

### 跨目录文件支持

当对比来自不同目录的文件时，显示名称会自动展示从公共父目录开始的相对路径，便于清晰识别。

示例：来自 `/project/exp1/file1.wav` 和 `/project/exp2/file1_pred.wav` 的文件，显示为 `exp1/file1.wav` 和 `exp2/file1_pred.wav`。

不同目录下的同名文件会自动分组，标签显示为所在目录名。

## 使用方法

### 打开文件

| 方式 | 说明 |
|---|---|
| **双击** | 在资源管理器中双击音频文件，直接在 SpecView 中打开 |
| **右键菜单** | 选中多个音频文件 → 右键 → "Open with SpecView" → 在同一窗口中打开 |
| **命令面板** | `Ctrl+Shift+P` → 输入 "SpecView: Open Audio File" → 文件选择器 |
| **点击添加区域** | 点击 "Click to add audio files" 区域 → 文件选择器（默认打开上次文件所在目录） |

### 键盘快捷键

| 按键 | 功能 |
|---|---|
| `Space` | 播放 / 暂停 |
| `Shift + Space` | 在分组内切换轨道（A/B 对比） |
| `Escape` | 停止播放并重置位置 |
| `←` / `→` | 后退 / 前进 2 秒 |
| `↑` / `↓` | 切换到上一个 / 下一个卡片（轨道或分组） |
| `Shift + ↑` | 时间轴放大 |
| `Shift + ↓` | 时间轴缩小 |
| `Shift + ←` | 重置缩放（显示全部） |
| `Delete` | 删除当前轨道（分组内则移除当前 Lane） |

## 系统要求

- VS Code 1.85.0 或更高版本
- 首次使用 ML 模型时需要网络连接（从 HuggingFace 下载约 20MB）

## 许可证

[Apache-2.0](LICENSE)

## 致谢

- 基于 [SpecView](https://github.com/RicherMans/SpecView)（作者：Heinrich）
- 音频分类由 [CED-tiny](https://huggingface.co/mispeech/ced-tiny)（ONNX Runtime Web）提供支持
