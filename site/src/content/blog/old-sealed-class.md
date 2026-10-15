---
title: 奇妙的 Sealed
date: '2025-09-03T15:21:27+08:00'
updated: '2026-03-09T09:54:01.024Z'
legacyPath: /2025/09/03/old-sealed-class/
categories:
  - Kotlin
tags:
  - Kotlin
  - Sealed Class
---

**该篇内容为原博客博文，原上传于2023年1月18日。**

**Sealed Class**和**Sealed Interface**是 kotlin 引入的全新特性。在初学 kotlin 时，我就一直没有掌握其用法，甚至到现在也不能在该用的时候立刻想到。

本篇文章主要总结**Sealed Class**的基本概念和常见用法。

### 什么是 Sealed

jetbrains 对 Sealed Class/Interface 的介绍如下：

> Sealed classes and interfaces represent restricted class hierarchies that provide more control over inheritance. All direct subclasses of a sealed class are known at compile time. No other subclasses may appear outside a module within which the sealed class is defined. For example, third-party clients can't extend your sealed class in their code. Thus, each instance of a sealed class has a type from a limited set that is known when this class is compiled.
>
> The same works for sealed interfaces and their implementations: once a module with a sealed interface is compiled, no new implementations can appear.
>
> In some sense, sealed classes are similar to enum classes: the set of values for an enum type is also restricted, but each enum constant exists only as a single instance, whereas a subclass of a sealed class can have multiple instances, each with its own state.

从以上介绍可以大致总结出 Sealed Class/Interface 有如下特性：

- 表示受限的类层次结构，并可以对继承提供更多的控制
- 密封类的子类在编译期即被确定为一个有限的集合内，不可扩展
- 密封类的子类只能位于定义了该密封类的**包**中
- 密封类的子类可以有多个实例

介绍中还提到，sealed class 和 enum class 在某种意义上是类似的，实际上，sealed class 诞生的重要原因之一正是为了克服 enum class 在某些场合下的局限性，也即上述特性的第一点和第四点。我们知道，枚举类有两个特性，在某些场合下是优点，但在另外一些场合下却可能成为缺点：

- 每个枚举类型只能有一个实例（称为枚举常量）
- 各枚举常量只能使用相同类型的属性

```kotlin
enum class Drink(val id: Int) {
    Milk(1),
    Coffee(2),
    Water(3)
}
```

在如上我们创建的枚举类中，各子类（Milk，Coffee，Water）无论有多少对象，都只能有一个实例（即单例的枚举常量），且其属性均只能为枚举类中定义的 Int 类型。

而密封类则取消了以上限制，允许密封类的子类具有多个实例，且各子类可以定义自己的属性。

```kotlin
sealed class Drink {
    // 这里直接在定义块内定义子类
    class Milk(val id: Int): Drink()
    class Coffee(val id: Double): Drink()
    class Water(val id: String): Drink()
}
```

如上，密封类允许各子类具有不同类型的属性，只需要在子类的主构造函数中声明即可。需要注意的是，密封类在继承上的写法与抽象类区别较大，反而更加类似于一般的抽象类。实际上，密封类正是抽象的，不能直接生成实例，且可以具有抽象成员。因此，密封类可以像上述写法一样定义继承自密封类的子类，也可以用`object`直接定义子类对象，也可以再用`sealed class`，即密封类继承密封类，实现更加细粒度的类层次结构。

各子类允许有多个不同状态的实例：

```kotlin
val milk1 = Drink.Milk(1)
val milk2 = Drink.Milk(2)
println(milk1.id)
println(milk2.id)
```

上述特性的第二点意义在于，密封类对运行时的扩展是封闭的。程序在编译时，即可通过继承关系确认密封类的全部子类，由此产生了密封类一个非常实用的用处，在写 when 语句时不需要添加 else 分支，因为全部可能的分支在编译时即可确定，没有其他情况：

```kotlin
fun test(drink: Drink) = when (drink) {
    is Drink.Milk -> println("milk")
    is Drink.Coffee -> println("coffee")
    is Drink.Water -> println("water")
}
```

上述特性的第三点意义在于，限制了密封类的作用空间，并且随着 kotlin 版本的更迭越来越宽松：从只能在 sealed class 内，到 1.1 支持同一文件内，到 1.5 支持同一包下。

### 怎么用 Sealed

kotlin 初学者往往会把`sealed class`当做`enum class`用，但`enum class`具有很明显的适用场景，这么做是不合适的。比如，你仅需要一系列相同类型的单例，且不需要任何额外描述，也不需要特殊的函数，那么用枚举就足够了，比如在我的《设计模式之状态模式》中，各状态有统一的处理方法，用枚举来表示。

在 Android 开发中， `sealed class`有如下一些使用场景：

- 列表有不同类型的子项（文字、图片），用密封类表示列表的 item

- 封装网络请求中成功（含有任意类型的请求数据）和失败（含有失败信息，如异常）返回的数据

- 使用`object`达到与枚举类似的效果（虽然在 google 的官方示例都出现了这种用法，但还是不推荐。为什么不直接用枚举呢？）

- 其他一切不满足枚举的应用场景，但需要与枚举类似效果，可以考虑用密封类

### 关于 Sealed Interface

以上都在讨论`sealed class`，而`sealed interface`作为 kotlin1.5 中登场的新特性，也值得说道说道。

密封接口进一步补足了密封类和枚举类的一些不足之处，如枚举类编译后继承自`Enum`，由于单继承不能再继承其他类，此时可以用密封接口，对枚举类做进一步划分。当然直接用嵌套密封类也未尝不可。

### Sealed 的收益在哪

一开始我对使用`sealed`没感觉到必要性，认为他绕来绕去其实也就只是帮我省个`when else` 分支罢了，这确实是有眼不识泰山，严重低估了`sealed`的使用收益。

实际上，它不是单纯省 else，而是帮编译器对相关类型推断从“只能靠猜”提升成“已知”。用了 sealed 以后，Kotlin 编译器就可以知道直接子类型是有限的，并且不允许再在模块和包外冒出新的直接子类或实现。这就带了许多潜在好处：
- 设计层面更清晰
- 重构时更安全
- 新增分支时更容易被全局发现

比如一个常见的使用场景，定义一个`Result`类/接口，写几个子类表示具体操作结果：

```kotlin
when (result) {
    Result.Loading -> ...
    Result.Success -> ...
    else -> ...
}
```

假设现在我们需要新增一种 Result:

```kotlin
data object Empty : Result
```

由于我们之前写了 else 兜底处理，所以新增之后， Empty 会悄悄掉进 else 分支，这就是隐患，如果这种分支在项目中大量存在，很难全部发现并加上。

但如果我们用 sealed 来表示结果的受限继承结构：

```kotlin
sealed interface Result {
    data object Loading : Result
    data object Success : Result
    data object Error : Result
}
```

除了省去 else，在我们新增 Empty 后，所有没处理完的 when 都会爆红，这就天然形成一张保护网，帮助我们规避隐藏的重构问题，并且分支越多越复杂，收益也越大。
