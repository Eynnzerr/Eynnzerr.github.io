---
title: 对 MVI 与 MVVM 的思考.md
date: '2026-03-01T01:03:32+08:00'
updated: '2026-02-28T17:04:15.433Z'
legacyPath: /2026/03/01/MVI与MVVM-md/
categories:
  - Android
tags:
  - MVI
  - MVVM
---

经常能在网上看到开发者争吵对于Android开发，究竟什么样的架构才是最好的。MVC 早已过时，MVP 在现代compose框架下很别扭，所以争论的焦点往往是 **MVVM VS MVI**。

明确概念区分是有必要的，但我觉得实在是没必要把它当成非黑即白的大事。看过许多开源项目，**在 Android + Compose 语境里，所谓 MVVM 和 MVI，实际落地后确实只差一层皮：**

现在大家对于状态管理的普遍写法是：
- `ViewModel` 持有 `StateFlow`
- Compose `collect`
- UI 调 `viewModel.xxx()`

这时如果有人嘴上说自己是 MVI，但代码只是：
- 多定义了个 `Intent`
- 多定义了个 `Effect`
- `onClick` 改成 `sendEvent(intent)`
- 内部拿`when`识别接着走不同逻辑

那在我看来，这只是**MVVM 套了 MVI 命名风格**，不是什么本质区别，这样的MVI实际上根本不足以称之为MVI。MVI 与 MVVM 的真正区别，不在于有没有 `Intent` / `Effect` 类型，而在于是否真的在代码中采用了两种不同的状态管理哲学。对于MVI来说：
- 是否有 reducer 思维？
- 是否有严格的单向状态演化约束？
- 是否真正分离了状态和副作用？

在 MVVM 中，ViewModel 是页面逻辑中心，对外暴露状态，并直接提供若干命令式方法给 UI 调用，状态更新逻辑也散落在各方式中，相对自由奔放。例如：

```kotlin
fun onRefresh() { ... }
fun onRetry() { ... }
fun onKeywordChange(value: String) { ... }
fun onItemClick(id: String) { ... }
```

这使得业务代码写起来很灵活，直接新增方法就好了，逻辑都写方法里，状态有变化直接在这里update就好了，UI按需调用。代价则是基本没有对状态的任何范式约束。

而在 MVI 中，所有输入先被建模成 `Intent`；所有页面可见信息收敛成单一 `State`；状态变化应只通过 reducer 统一规则演化，并且明确隔离副作用，派生出`Effect`。也就是说，MVI 的重点不是“多定义几个 sealed class”，而是：
- **状态转移是否被统一建模**
- **所有用户动作和系统动作是否都走统一入口**
- **副作用是否被明确区分，不混进 state**

所以说，很多人把区别理解成：MVVM就是UI调用 `onClick()`，MVI就是UI调用 `sendEvent(Intent.Click)`，这太浅了，也根本不是核心。如果还纠结于类似方法名怎么起、sealed class 要不要写、 一次性事件叫 effect 还是 event 这类价值不高的争论上，实属可惜。真正的区别更接近于：MVVM把ViewModel用来当页面管理者，功能自己设计；而MVI则是把ViewModel当成一个出入口，统一输入输出，内部维护一个状态机，所有输入都驱动状态机的转移，输出新状态。

也因此在我看来，虽然这两种架构经常被放在一起对比，但实际上他们所反映的思路并非同一维度：
- MVVM 是一种更强调对架构的严格分层与View/Model解耦
- MVI 则是在此基础之上，强调状态流转的建模思路

严格讲，很多 Android 项目其实就是**MVVM 外壳 + MVI 风格状态管理**：
- MVVM解决架构分层：View层对应Composable，ViewModel层就是ViewModel，Model层对应依赖的Repository及其下的数据源；
- MVI解决页面状态流转与事件消费：用 Intent / State / Effect / Reducer 的方式组织。

所以在我看来它们并不完全互斥，很多成熟写法其实就是架构层面是 MVVM 而状态管理层面借鉴 MVI。过度区分是没有必要的，不应为了比较而比较，谁优谁劣更是没有定数。
