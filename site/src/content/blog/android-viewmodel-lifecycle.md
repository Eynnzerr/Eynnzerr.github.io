---
title: 'ViewModel 为什么能跨重建存活：Store、Owner 与保存状态'
description: '沿着 Activity 配置变更的对象转交过程，理解 ViewModelStore、Provider、key 和作用域，再区分内存保留、SavedStateHandle 与长期持久化。'
date: '2026-03-06T18:53:34+08:00'
categories: [Android, Jetpack]
tags: [Android, ViewModel, Lifecycle, SavedStateHandle]
updated: '2026-10-15'
---

旋转屏幕后，Activity 实例变了，ViewModel 却可能还是原来的对象。原因在于 Activity 重建时，框架保留并转交了包含 ViewModel 的 `ViewModelStore`。

先把存储关系画出来：

```text
Activity / Fragment / 导航作用域
             ↓ 实现
     ViewModelStoreOwner
             ↓ 提供
        ViewModelStore
             ↓ 按 key 保存
          ViewModel
```

`ViewModelProvider` 则负责查询 Store：存在合适实例时复用，否则通过 Factory 创建。理解了这层关系，就能解释为什么同一类 ViewModel 有时共享、有时独立，以及为什么页面不可见后任务仍可能继续。

## 配置变更时，真正保留下来的是哪一层

假设 Activity A 已通过 Provider 获得 ViewModel V，V 位于 Store S 中。旋转触发配置变更后的对象关系如下：

```text
旋转之前：Activity A  → Store S → ViewModel V
                          │
配置变更：A 销毁，框架保留 S
                          │
旋转之后：Activity A' → Store S → ViewModel V
```

新的 Activity A' 有新的普通成员字段，但重新查询同一 Store、同一 key 时，能够拿到旧的 V。

![Activity 因旋转重建时 ViewModel 保持存活，Activity 结束后 ViewModel 才被清理](/images/blog/android-viewmodel-lifecycle/lifecycle.png)

图源：[Android Developers：ViewModel lifecycle](https://developer.android.com/topic/libraries/architecture/viewmodel#lifecycle)，原图保留，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用。

AndroidX `ComponentActivity` 的实现展示了三个相互配合的步骤：

1. 配置变更时，`onRetainNonConfigurationInstance()` 将 Store 放进待转交的 non-config 对象。
2. 新 Activity 的 `ensureViewModelStore()` 优先从 `lastNonConfigurationInstance` 取回 Store。
3. 收到销毁事件时，只有在不是配置变更的情况下才清理 Store。

这段转交发生在同一进程的内存中。non-config 对象与用于状态保存的 Bundle 有不同用途：前者保留对象实例，后者保存可用于重建的数据。[ComponentActivity 源码](https://github.com/androidx/androidx/blob/androidx-main/activity/activity/src/main/java/androidx/activity/ComponentActivity.kt)

## `by viewModels()` 没有绕开 Provider

```kotlin
private val viewModel: SearchViewModel by viewModels()
```

这里的 Kotlin 属性委托提供延迟获取：第一次访问属性时，找到 Owner 的 Store，连同 Factory 和创建参数一起交给 Provider，再缓存获取结果。它不会在每次 Activity 重建时无条件执行 `SearchViewModel()`。

因此，下面三种操作的含义不同：

| 操作 | 实例来自哪里 |
| --- | --- |
| 直接调用构造函数 | 新建普通对象，脱离 Provider 的复用与清理管理 |
| 从同一个 Owner、同一个 key 获取 | 通常复用同一实例 |
| 从不同 Owner 获取 | 各自作用域内独立保存 |

对于 Fragment，`by viewModels()` 和 `by activityViewModels()` 的差别就在 Owner：前者使用 Fragment 作用域，后者使用所属 Activity 作用域。共享 ViewModel 应当是明确选择作用域后的结果。

## Store 的真正索引是 key

Store 以字符串 key 保存 ViewModel。没有手动传 key 时，Provider 通常根据模型类名生成默认 key，所以同一 Owner 内连续获取同一模型类，通常得到同一个对象。

如果需要同一模型类的两个独立实例，可以给出不同 key。以下代码放在已创建的 `ComponentActivity` 中：

```kotlin
val provider = ViewModelProvider(this)
val left = provider["left-search", SearchViewModel::class.java]
val right = provider["right-search", SearchViewModel::class.java]
```

这里的 Factory 仍需支持 `SearchViewModel` 的创建。下文的 SavedStateHandle 构造方式可由配置了保存状态的默认 AndroidX Factory 支持。

需要精确区分：Store 并不是以“key 与类型组成的二元组”为索引。Provider 先按 key 找对象，再检查类型；同一 key 用于另一个不兼容的模型类型时，会创建替代实例。因此手动 key 应在同一个 Store 内具有明确、稳定的用途。[ViewModelProviderImpl 源码](https://github.com/androidx/androidx/blob/androidx-main/lifecycle/lifecycle-viewmodel/src/commonMain/kotlin/androidx/lifecycle/viewmodel/internal/ViewModelProviderImpl.kt)

## 看不到页面，不等于作用域结束

ViewModel 的生命周期跟随其 Owner 的存储作用域，而不是跟随每一次界面绘制。

- Activity 配置变更时 Store 保留；Activity 正常结束时清理。
- Fragment 的 View 被销毁后，Fragment 作用域的 ViewModel 仍可能保留，所以 `onDestroyView()` 不是它必然结束的时刻。
- 导航目的地或导航图可以拥有自己的 Store；目的地离开前台后，只要对应作用域仍被保留，ViewModel 就可能继续存活。

对于常规导航栈，移除目的地并释放其作用域会清理相应 ViewModel。启用保存、恢复返回栈等机制时，还要结合导航配置判断存储何时真正释放。应检查所选 Owner，而不是仅凭 composable 是否仍显示来推断。

`viewModelScope` 同样跟随 ViewModel 清理而取消。UI 使用 `collectAsStateWithLifecycle()` 停止收集，和 ViewModel 内部协程停止工作，是两件事；上游是否停止还取决于 Flow 的共享策略和任务设计。

## 进程死亡后恢复的是数据

进程死亡会销毁 ViewModel 实例和 Store。系统稍后恢复页面时，可以根据保存状态创建新的 ViewModel，再恢复需要的小块数据。

`SavedStateHandle` 适合查询词、选中项 ID、筛选条件等轻量状态。下面让查询词通过 StateFlow 暴露给 UI：

```kotlin
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.StateFlow

/** Keep the query needed to reconstruct a search screen. */
class SearchViewModel(
    /** State restored through the owner's saved-state mechanism. */
    private val savedStateHandle: SavedStateHandle
) : ViewModel() {
    /** Current query, restored from saved state when available. */
    val query: StateFlow<String> = savedStateHandle.getStateFlow("query", "")

    /** Update the query and the value eligible for saved-state restoration. */
    fun onQueryChange(value: String) {
        savedStateHandle["query"] = value
    }
}
```

恢复时有查询词，就能再次读取数据库或请求数据。把完整搜索结果、巨大 Bitmap 等对象塞进保存状态，既放大保存成本，也混淆了状态恢复和数据持久化。

SavedStateHandle 依赖系统的任务与保存状态机制。用户强行停止应用、移除任务或重启设备后，不能用它代替长期存储；在停止状态期间写入的更新，也需要后续合适的保存时机才能进入可恢复快照。[Saved State module](https://developer.android.com/topic/libraries/architecture/viewmodel/viewmodel-savedstate)

## 为什么不把旧 Activity 放进 ViewModel

配置变更后，ViewModel 仍可能存活。如果它持有旧 Activity、View 或与其绑定的回调，就会把已经失效的界面对象一起留住。

更合适的边界是让 ViewModel 暴露状态和业务事件：UI 负责显示、导航、Activity Result 注册；ViewModel 负责页面状态和业务协调。清理 ViewModel 时释放属于它的资源，而不是依赖 `onCleared()` 在所有进程退出方式下运行——进程直接结束时没有这样的回调保证。

由此可以把三个保存层次分别安排：配置变更期间继续使用的页面状态放 ViewModel，重建页面所需的轻量输入放 SavedStateHandle，用户期望下次启动仍然存在的数据放持久层。

## 参考资料

- [ViewModel 概览与生命周期](https://developer.android.com/topic/libraries/architecture/viewmodel)
- [ViewModel 作用域 API](https://developer.android.com/topic/libraries/architecture/viewmodel/viewmodel-apis)
- [SavedStateHandle 与保存状态边界](https://developer.android.com/topic/libraries/architecture/viewmodel/viewmodel-savedstate)
- [ComponentActivity 的 non-config 转交实现](https://github.com/androidx/androidx/blob/androidx-main/activity/activity/src/main/java/androidx/activity/ComponentActivity.kt)
- [ViewModelProvider 的 key 查询与类型检查](https://github.com/androidx/androidx/blob/androidx-main/lifecycle/lifecycle-viewmodel/src/commonMain/kotlin/androidx/lifecycle/viewmodel/internal/ViewModelProviderImpl.kt)
- [NavBackStackEntry API](https://developer.android.com/reference/androidx/navigation/NavBackStackEntry)
