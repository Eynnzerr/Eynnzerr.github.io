---
title: 功能开始交叉组合时，继承树应该长到哪里为止
description: 从角色的移动与攻击能力出发，讨论如何拆开独立变化的维度，再用 Kotlin 委托和 Android ContextWrapper 理解组合的实际边界。
date: '2026-02-02T14:27:06+08:00'
categories: [软件设计, 面向对象]
tags: [组合, 继承, Kotlin, 设计模式, Android]
updated: '2026-10-15'
---

继承适合表达稳定的类型关系，组合适合连接可以独立变化的能力。当需求开始沿着多个方向变化时，继续增加子类，往往会把这些方向硬挤进同一棵树。

选择复用方式时，先看哪些能力会独立变化，再决定它们通过类型层级还是对象协作连接。

## 从一种分类，变成两种同时存在的分类

以一个角色系统为例，最初只有近战角色和施法角色，按攻击方式划分子类很自然。后来加入飞行能力，类型开始交叉：

| 移动方式 | 近战 | 法术 |
| --- | --- | --- |
| 步行 | 步行战士 | 步行法师 |
| 飞行 | 飞行战士 | 飞行法师 |

如果把每个组合都编码成一个子类，新增一种移动方式，就要继续考虑它与各类攻击方式的组合。更深的继承树也无法消除这个问题，因为“移动”和“攻击”本来就是两个独立维度。

这时可以让角色持有两种能力：

```kotlin
/** Describes one movement behavior. */
fun interface Movement {
    /** Produce the action represented by this movement. */
    fun move(): String
}

/** Describes one attack behavior. */
fun interface Attack {
    /** Produce the action represented by this attack. */
    fun execute(): String
}

/** Combines independently selected movement and attack behaviors. */
class Character(
    /** Movement used by this character. */
    private val movement: Movement,
    /** Attack used by this character. */
    private val attack: Attack,
) {
    /** Perform a movement followed by an attack in this example. */
    fun act(): List<String> = listOf(movement.move(), attack.execute())
}

val walk = Movement { "向前移动" }
val fly = Movement { "飞向目标" }
val sword = Attack { "挥剑" }
val spell = Attack { "施法" }

val warrior = Character(walk, sword)
val flyingMage = Character(fly, spell)
```

示例用字符串表示动作。移动能力和攻击能力各自实现自己的行为，新增角色组合只需要调整组装代码。

组合也不必依赖可变属性。上面的能力通过构造器确定，此后保持不变，同样可以获得清晰的拆分。是否允许运行时替换，是另一项业务决定。

## 抽出能力以后，契约仍然要足够小

如果把所有行为都放进一个 `CharacterAbility` 接口，要求每个实现都提供飞行、施法、游泳、近战，再用空方法或抛异常应付用不到的能力，问题只是从继承树搬进了大接口。

契约应描述调用者真正需要的行为。需要移动的代码依赖 `Movement`，需要攻击的代码依赖 `Attack`。对于某些角色没有的能力，可以在类型或组装规则中明确表达，不必要求所有角色假装支持所有行为。

抽象边界的质量可以从一个变化来检查：新增一种攻击方式时，需要修改哪些文件？如果每个移动实现都被迫改动，两个维度仍然没有真正分开。

## 委托把“转发给成员”写得更直接

组合经常伴随委托：对象持有另一个对象，并把部分调用交给它完成。Kotlin 的接口委托 `by` 可以生成这类转发。

假设一个文档存储契约有读取和写入两种操作，希望仅为写入增加记录：

```kotlin
/** Stores and retrieves the current text document. */
interface DocumentStore {
    /** Return the current document. */
    fun read(): String

    /** Replace the current document. */
    fun write(text: String)
}

/** Records writes while forwarding storage operations to an existing store. */
class LoggingStore(
    /** Store that performs the actual persistence. */
    private val delegate: DocumentStore,
    /** Callback receiving operation summaries. */
    private val log: (String) -> Unit,
) : DocumentStore by delegate {
    /** Persist the text and record the successful write. */
    override fun write(text: String) {
        delegate.write(text)
        log("Wrote ${text.length} characters")
    }
}
```

`read()` 自动转发给 `delegate`，`write()` 由包装对象明确实现。外部仍然通过 `DocumentStore` 使用它，真正的存储对象可以单独变化。

`by` 的转发不会改写被委托对象内部的调用。如果底层对象自己的方法调用了另一个成员方法，接收者仍然是底层对象；包装层覆写的方法不会因此自动拦截这次内部调用。想控制内部步骤，需要底层实现提供相应扩展点，或者把步骤进一步拆成可注入的协作对象。Kotlin 官方文档专门说明了这一点。

还有一项业务上的细节：上面先存储再记录，表示日志描述一次已经完成的写入。若日志回调抛出异常，调用者需要怎样理解这次操作，应由实际系统约定。包装层增加行为时，原有操作的成功、失败和副作用顺序也会随之成为契约的一部分。

## Android 的 ContextWrapper 把两种关系放在了一起

`ContextWrapper` 本身是 `Context` 的子类，同时持有一个基础 `Context`，并把许多操作委托给它：

```text
类型关系：ContextWrapper 是一种 Context
对象关系：ContextWrapper 持有 base Context
调用关系：包装对象把默认行为转发给 base
```

因此，它同时使用了继承与组合。继承使调用者可以继续按照 `Context` 契约使用包装对象；组合使实际行为能够由已有的 Context 提供。

`ContextThemeWrapper` 又在这个基础上提供主题相关行为。使用主题资源 ID 的构造方式，会把指定主题应用在基础 Context 的主题之上；接收 `Resources.Theme` 的构造方式则使用给定主题替换基础主题。

这样的结构体现了装饰者的作用：保留外部契约，通过持有和调用已有对象，在选定的位置增加或调整行为。

## 继承仍然需要满足什么

当子类确实能够遵守父类型的行为约定，并且父类有意提供稳定的扩展点时，继承依然有价值。Kotlin 将类和成员默认设为 `final`，需要显式开放继承和覆写，也让“这里允许怎样扩展”成为需要表达的设计决定。

真正值得停下来重看结构的信号，是子类开始关闭父类功能、依赖父类内部调用顺序，或者为了组合两个独立特征而复制已有子类。这时先把变化点拆成小的协作对象，通常比继续加深层级更容易说明清楚。

组合的代价是多了一层连接和转发。只有当这层连接隔开了实际会变化的职责，它才带来可维护性；如果所有对象总是一起变化，拆成许多空壳接口只会增加阅读负担。

## 参考资料

- [Kotlin：Delegation](https://kotlinlang.org/docs/delegation.html)，接口委托及覆写对内部调用的影响。
- [Kotlin：Inheritance](https://kotlinlang.org/docs/inheritance.html)，类与成员的开放、覆写规则。
- [Android：ContextWrapper](https://developer.android.com/reference/android/content/ContextWrapper)，基础 Context 的包装与委托。
- [Android：ContextThemeWrapper](https://developer.android.com/reference/android/view/ContextThemeWrapper)，主题包装及两种构造方式的区别。
