---
title: 正确理解Kotlin属性
date: '2026-03-12T11:45:59+08:00'
updated: '2026-03-12T03:46:18.684Z'
legacyPath: /2026/03/12/正确理解Kotlin属性/
categories:
  - Kotlin
tags:
  - Kotlin
---

请读者思考，如下两种写法有什么不同？

```kotlin
val a: String
    get() = "Android"
    
val b = "Android"
```

我们在文章末尾揭晓答案。

## Kotlin 属性

Kotlin 的属性是语言级概念，不等同于 Java 的字段。在 Kotlin 中我们写 `obj.x`，实际上是在调用访问器函数：
- 读 `obj.x` 等价于调用 `obj.getX()`
- 写 `obj.x = v` 等价于调用 `obj.setX(v)`（仅 `var` ）

所以说属性更像“访问器函数的语法糖”，字段只是可能存在的实现细节，并且这也是为什么我们在kotlin中不会为属性手写getXX()/setXX()这样的样板方法，否则你会收到来自编译器的警告：Redundant getter/setter，除非要自定义实现（下面提及）。

## getter 和 setter 的本质

- `val` 只有 getter 函数。
- `var` 有 getter 和 setter。
- getter/setter 都是函数，参与多态，可被 override。
- getter的默认实现就是读field，setter的默认实现就是写field。

默认情况下，如果写了初始化的值或使用默认访问器，编译器会生成相应访问器。

## backing field

backing field 是“用于存储属性值的隐藏字段”。在 JVM 上它最终会变成 class 里的一个字段，反编译成 Java 通常表现为 `private` 。

并不是每个属性都有 backing field，比如：
- 有初始化值且不是纯**计算属性**，通常有 backing field。
- 访问器里使用了 `field`，一定需要 backing field。
- 纯 `get() = ...` 的计算属性通常没有 backing field。

### `field` 的意义

`field` 只在该属性的 getter/setter 内部可用，代表 backing field。如果在 getter/setter 里想访问存储的属性值，应该用`field`；如果用属性名 `x` 会递归调用访问器，导致 stack overflow。

## 属性可以是纯函数

如果属性没有 backing field，它就只是一个 getter 方法，每次访问都会重新计算，没有存储。我们称这种属性为**计算属性**。

```kotlin
val now: Long
    get() = System.currentTimeMillis()
```

## 覆写规则

属性可以 override，本质上就是在 override 访问器函数。
- 父类要 `open` 才能被子类 override。
- 接口属性默认可 override。
- `val` 可以被 `var` override（子类提供更强能力：可读可写）。 
- `var` 不能被 `val` override（子类少了 setter，破坏父类契约）。

override 覆写的是访问器行为，不是“同一个字段”。子类可以有自己的存储，也可以是计算属性。

## 编译到 JVM 后的样子

如果属性有 backing field，反编译到 Java 通常是
- 一个 `private` 字段存值
- 一个 `getX()` 方法
- 如果是 `var` 再有一个 `setX(value)` 方法

如果属性是计算属性，则通常只有 `getX()`，没有字段。

属性委托的常见形态就是生成一个保存 delegate 的字段，例如 `x$delegate`，实际值存不存 `x` 字段要看委托实现。

默认情况下，Java 侧仍通过 getter/setter 访问，而不是直接字段访问。想让 Java 直接字段访问，需要显式要求（例如 `@JvmField`，或 `const val` 等）。

## 总结

看到一个属性，问自己3个问题即可快速判断其行为：
1. 读它会发生什么？看 getter。
2. 写它会发生什么？看 setter（如果是 `var`）。
3. 它存不存值？看是否需要 backing field（是否初始化，是否用了 `field`，是否是纯计算属性）。

所以回到文章开头的问题，都是拿一条"Android"的字符串，这两种写法的区别是什么？

```kotlin
val a: String
    get() = "Android"
    
val b = "Android"
```

### a 没有 backing field

```kotlin
val a: String  
    get() = "Android"
```

既没有调`field`，也不是默认访问器，这是计算属性，每次调用直接返回`"Android"`的运算结果，从字符串常量池找"Android"的引用并返回。

### b 有 backing field

```kotlin
val b: String = "Android"
```

会有字段来存这个属性值，哪怕它的值本身也是字符串常量，不过要注意**字段里存的依旧是一个引用**，这个引用也很可能指向字符串池里的 `"Android"` 对象，不是说字段里复制了一份字符串内容。

所以 `b` 的情况是“有字段，字段指向常量字符串对象”，而 `a` 的情况是“没字段，getter 直接返回常量字符串对象引用”。
