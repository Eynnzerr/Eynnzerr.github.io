---
title: 为什么我开始在意依赖注入：把对象组装从业务代码里拿出来
description: 从 YuukaTalk 中逐渐暴露的对象创建问题出发，讨论手动注入、依赖倒置、Service Locator 和 Android 作用域各自解决什么。
date: '2026-03-18T15:50:23+08:00'
categories: [软件设计, 架构]
tags: [依赖注入, Kotlin, Android, 依赖倒置]
updated: '2026-10-15'
---

在 YuukaTalk 里，随着页面和需求增多，我逐渐发现，全局 `object`、工具类和对象初始化代码会把依赖关系藏起来：有的 ViewModel 自己创建 Repository，有的地方直接访问单例，另一处又需要补一套 Factory。每段代码单独看都能工作，放在一起之后，“这个对象由谁创建、能活多久、谁在共享它”却越来越难追踪。

依赖注入对我最直接的价值，是把**对象的组装位置**从**使用对象的业务逻辑**里分离出来。先把这条边界理清，再决定是否需要框架，才容易判断多出的配置有没有解决实际问题。

## 一个类为什么会知道得太多

假设个人资料页面需要加载用户名。如果页面控制器在内部创建网络客户端，再用客户端创建 Repository，那么它同时承担了几种决定：

```text
页面控制器
  ├─ 决定何时加载用户名
  ├─ 决定使用哪种 Repository
  ├─ 决定怎样配置网络客户端
  └─ 决定这些对象怎样复用
```

页面行为只依赖“可以加载用户名”这项能力，但实现却知道整条创建链。替换数据来源时，要修改页面内部；想在没有网络的环境中观察页面行为，也容易被真实依赖绑住。

可以先把页面所需的能力表达出来。下面使用一个普通 Kotlin 类演示依赖关系，不包含 Android 组件的创建过程：

```kotlin
/** Provides the current user's display name. */
interface UserRepository {
    /** Load a display name from the configured data source. */
    suspend fun loadName(): String
}

/** Formats a greeting using the repository supplied by its owner. */
class ProfileGreeting(
    /** Repository selected by the composition code. */
    private val repository: UserRepository,
) {
    /** Load the name and apply the presentation rule. */
    suspend fun load(): String = "你好，${repository.loadName()}"
}
```

`ProfileGreeting` 仍然有依赖，但依赖已经进入构造器，变成创建对象时必须满足的条件。它不再决定数据库路径、网络地址或全局单例来自哪里。

## 注入从手动传参就已经开始

为了给示例提供一个固定的数据来源，可以写一个小实现：

```kotlin
/** Returns a fixed name for a preview or an isolated caller. */
class FixedUserRepository(
    /** Name returned by this instance. */
    private val name: String,
) : UserRepository {
    /** Return the configured value without external I/O. */
    override suspend fun loadName(): String = name
}

val repository = FixedUserRepository("Eynnzerr")
val greeting = ProfileGreeting(repository)
```

外部创建依赖，再把它传给使用者，这已经是构造器注入。网络实现和固定值实现可以在组装位置替换，业务类不需要知道替换发生了。

在稍大一点的应用里，可以用一个 `AppContainer` 集中构造可复用依赖，再由页面工厂创建页面所需对象。这个组装位置承担“谁连接谁”的职责，业务类承担“拿到依赖后做什么”的职责。Android 官方的手动 DI 指南也从这种容器逐步引出对象生命周期问题。

容器负责组装，类的职责仍然由业务边界决定。构造器里出现越来越多参数，可能提示当前类承担了过多工作。

## 依赖注入与依赖倒置是两条不同的判断

构造器参数即使是某个具体类，也可以通过外部传入，这依然属于 DI。依赖倒置进一步关心的是：高层规则在源码层面依赖哪个契约，具体实现是否围绕这个契约提供能力。

在上面的例子里，`ProfileGreeting` 使用 `UserRepository` 契约；网络、数据库或固定值实现都实现这个契约。高层规则无需知道数据保存在哪里。

接口的价值来自一个明确边界。若一个简单类只有稳定的具体依赖，也没有替换需求，可以直接注入该依赖。采用接口时，具体实现由外部组装者选定，业务类只保留对契约的依赖。

## Service Locator 把选择权留给了谁

如果一个类在方法内部调用 `GlobalContainer.userRepository`，对象创建虽然集中到了容器，依赖获取仍由使用者自己发起。阅读构造器时看不出它还依赖全局容器，替换实现还可能影响其他同时使用这个全局状态的调用者。

这类方式通常称为 Service Locator。与构造器注入相比，最明显的区别是依赖出现的位置：

| 方式 | 依赖在哪里可见 | 谁负责交付依赖 |
| --- | --- | --- |
| 构造器注入 | 类型的构造参数 | 外部组装者 |
| Service Locator | 类内部的查找操作 | 使用者主动查找 |

框架入口、旧代码迁移等场景可能需要查找式获取。把这种获取限制在少量边界位置，再向内部传递具体依赖，可以减少业务代码对全局容器的依赖。

## Android 真正增加难度的是生命周期

一个网络客户端可以被多个页面共享，但某个页面的临时状态不应该因为被放进全局容器而活到整个进程结束。将 Activity 引用交给长生命周期对象，也可能让已经离开的页面继续被持有。

所以在确定创建方式之后，还要明确对象的所有者：

| 对象需求 | 需要回答的问题 |
| --- | --- |
| 跨页面复用 | 是否确实需要共享同一个实例，它是否保存用户会话状态 |
| 页面内使用 | 页面结束后谁释放引用，配置变化时是否保留 |
| 跟随 ViewModel | 是否应与该 ViewModel 的生命周期一致 |
| 持有文件、连接或任务 | 谁调用关闭或取消，何时执行 |

Hilt 通过与 Android 组件生命周期关联的组件和作用域管理实例复用。作用域决定某个组件范围内是否复用同一实例；关闭文件、取消任务和释放业务资源，则需要在相应的生命周期入口落实。

作用域越长，对它所持有对象的生命周期要求就越严格。进程级单例持有的页面引用，会把页面生命周期一并延长。

## 什么时候引入 DI 框架

手动组装足够清晰时，可以继续使用构造器和少量工厂。真正值得引入框架的信号，是大量重复装配、多个入口需要一致的对象图、复杂作用域，以及环境之间经常替换依赖。

Hilt 等框架把创建和连接对象的工作自动化，并与 Android 组件的创建入口衔接。框架选择取决于项目的语言、平台、构建约束，以及团队对其作用域规则的掌握程度。

对已经变得杂乱的项目，我会先从最外层业务类的一个依赖开始：把内部创建移到构造器外，明确所有者，再让一个入口负责组装。这样每次调整都对应一条看得见的依赖关系；等重复部分清楚了，再交给框架处理。

## 参考资料

- [Android Developers：Dependency injection in Android](https://developer.android.com/training/dependency-injection)，构造器注入与 Service Locator 的区别。
- [Android Developers：Manual dependency injection](https://developer.android.com/training/dependency-injection/manual)，手动容器与依赖生命周期。
- [Android Developers：Dependency injection with Hilt](https://developer.android.com/training/dependency-injection/hilt-android)，组件层级、生命周期和作用域。
