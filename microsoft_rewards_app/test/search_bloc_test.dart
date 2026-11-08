// SearchBloc 行为测试：覆盖自动搜索的核心状态路径。
//
// 取消路径对应计划书 F10：取消事件写出 SearchCancelled 后，底层循环通过
// break 正常返回，启动处理不得再无条件写出 SearchSuccess 覆盖取消状态。

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:microsoft_automatic_rewards/core/di/search_cancel_token.dart';
import 'package:microsoft_automatic_rewards/features/search/domain/repositories/search_repository.dart';
import 'package:microsoft_automatic_rewards/features/search/domain/useCases/perform_search.dart';
import 'package:microsoft_automatic_rewards/features/search/presentation/bloc/search_bloc.dart';

/// WebView 控制器在 bloc 层只被透传给用例，测试中不会真正调用其平台方法。
class _FakeWebViewController extends Fake implements InAppWebViewController {}

/// 复现 SearchRepositoryImpl 的取消行为：循环检测到取消后 break 并正常返回。
class _CancellingLoopRepository implements SearchRepository {
  @override
  Future<void> performSearches({
    required int count,
    required double delay,
    required SearchCancellationToken cancellationToken,
    required InAppWebViewController controller,
    required void Function(int currentCount, int totalCount) onProgress,
  }) async {
    var iterations = 0;
    // 迭代上限只是防止取消事件意外丢失时测试无限挂起。
    while (!cancellationToken.isCancelled && iterations < 1000) {
      iterations++;
      await Future<void>.delayed(Duration.zero);
    }
  }
}

/// 正常完成：按 count 上报进度后返回。
class _CompletingRepository implements SearchRepository {
  @override
  Future<void> performSearches({
    required int count,
    required double delay,
    required SearchCancellationToken cancellationToken,
    required InAppWebViewController controller,
    required void Function(int currentCount, int totalCount) onProgress,
  }) async {
    for (var i = 0; i < count; i++) {
      onProgress(i + 1, count);
    }
  }
}

/// 模拟某一步搜索失败抛出异常。
class _FailingRepository implements SearchRepository {
  @override
  Future<void> performSearches({
    required int count,
    required double delay,
    required SearchCancellationToken cancellationToken,
    required InAppWebViewController controller,
    required void Function(int currentCount, int totalCount) onProgress,
  }) async {
    throw StateError('webview failed');
  }
}

/// 复现「取消后旧轮次失败」：第一次调用等到取消令牌翻转后抛出异常（旧轮次
/// 的 WebView 调用在取消后仍会失败），之后的调用按 count 上报进度并正常
/// 返回（取消后立即重试的新轮次）。
class _OldRoundFailsAfterCancelRepository implements SearchRepository {
  var calls = 0;

  @override
  Future<void> performSearches({
    required int count,
    required double delay,
    required SearchCancellationToken cancellationToken,
    required InAppWebViewController controller,
    required void Function(int currentCount, int totalCount) onProgress,
  }) async {
    calls++;
    if (calls == 1) {
      var iterations = 0;
      while (!cancellationToken.isCancelled && iterations < 1000) {
        iterations++;
        await Future<void>.delayed(Duration.zero);
      }
      throw StateError('webview failed after cancel');
    }
    for (var i = 0; i < count; i++) {
      onProgress(i + 1, count);
    }
  }
}

void main() {
  final controller = _FakeWebViewController();

  group('SearchBloc', () {
    blocTest<SearchBloc, SearchState>(
      '搜索中取消时最终状态保持 SearchCancelled，不被 SearchSuccess 覆盖',
      build: () =>
          SearchBloc(performSearch: PerformSearch(_CancellingLoopRepository())),
      act: (bloc) {
        bloc.add(StartSearchEvent(count: 3, delay: 0, controller: controller));
        bloc.add(CancelSearchEvent());
      },
      expect: () => <Object>[
        SearchInProgress(),
        SearchCancelled(),
      ],
    );

    blocTest<SearchBloc, SearchState>(
      '搜索正常完成时按进度上报并以 SearchSuccess 结束',
      build: () =>
          SearchBloc(performSearch: PerformSearch(_CompletingRepository())),
      act: (bloc) => bloc.add(
        StartSearchEvent(count: 2, delay: 0, controller: controller),
      ),
      expect: () => <Object>[
        SearchInProgress(),
        SearchInProgress(currentCount: 1, totalCount: 2),
        SearchInProgress(currentCount: 2, totalCount: 2),
        SearchSuccess(),
      ],
    );

    blocTest<SearchBloc, SearchState>(
      '用例抛出异常时以 SearchFailure 结束',
      build: () =>
          SearchBloc(performSearch: PerformSearch(_FailingRepository())),
      act: (bloc) => bloc.add(
        StartSearchEvent(count: 2, delay: 0, controller: controller),
      ),
      expect: () => <Object>[
        SearchInProgress(),
        isA<SearchFailure>(),
      ],
    );

    // Bloc 默认并发处理事件，取消后旧轮次的异常可能在新轮次运行期间才抛出。
    // 此时启动处理器的 catch 必须按本轮令牌丢弃旧轮次的失败，不得覆盖新轮次。
    blocTest<SearchBloc, SearchState>(
      '取消后旧轮次抛出异常时，不写出 SearchFailure',
      build: () => SearchBloc(
        performSearch: PerformSearch(_OldRoundFailsAfterCancelRepository()),
      ),
      act: (bloc) {
        bloc.add(StartSearchEvent(count: 3, delay: 0, controller: controller));
        bloc.add(CancelSearchEvent());
      },
      expect: () => <Object>[
        SearchInProgress(),
        SearchCancelled(),
      ],
    );

    blocTest<SearchBloc, SearchState>(
      '取消后立即重试时，旧轮次的失败不得覆盖新轮次的成功',
      build: () => SearchBloc(
        performSearch: PerformSearch(_OldRoundFailsAfterCancelRepository()),
      ),
      act: (bloc) {
        bloc.add(StartSearchEvent(count: 3, delay: 0, controller: controller));
        bloc.add(CancelSearchEvent());
        bloc.add(StartSearchEvent(count: 1, delay: 0, controller: controller));
      },
      expect: () => <Object>[
        SearchInProgress(),
        SearchCancelled(),
        SearchInProgress(),
        SearchInProgress(currentCount: 1, totalCount: 1),
        SearchSuccess(),
      ],
    );
  });
}
