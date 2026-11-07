import 'package:bloc/bloc.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import '../../../../core/di/SearchCancellationToken.dart';
import '../../../../core/utils/error_handler.dart';
import '../../domain/useCases/perform_search.dart';
import 'package:equatable/equatable.dart';


class SearchBloc extends Bloc<SearchEvent, SearchState> {
  late SearchCancellationToken _cancelToken;
  final PerformSearch performSearch;

  SearchBloc({required this.performSearch}) : super(SearchInitial()) {
    on<StartSearchEvent>(_onStartSearch);
    on<CancelSearchEvent>(_onCancelSearch);
  }

  Future<void> _onStartSearch(
      StartSearchEvent event,
      Emitter<SearchState> emit,
      ) async {
    emit(SearchInProgress());
    final cancelToken = SearchCancellationToken();
    _cancelToken = cancelToken;
    try {
      await performSearch(
        count: event.count,
        delay: event.delay,
        cancellationToken: cancelToken,
        controller: event.controller,
        onProgress: (currentCount, totalCount) {
          emit(SearchInProgress(currentCount: currentCount, totalCount: event.count));
        },
      );
      // 取消时 _onCancelSearch 已写出 SearchCancelled；底层循环在取消后 break
      // 并正常返回，这里不得再写出 SearchSuccess 把取消覆盖成成功。
      // 使用本地的 cancelToken 而非 _cancelToken，避免新一轮开始后旧轮次
      // 读到新令牌而误判为未取消。
      if (cancelToken.isCancelled) {
        return;
      }
      emit(SearchSuccess());
    } catch (e) {
      emit(SearchFailure(ErrorHandler.getErrorMessage(e)));
    }
  }

  void _onCancelSearch(
      CancelSearchEvent event,
      Emitter<SearchState> emit,
      ) {
    emit(SearchCancelled());
    _cancelToken.cancel();
  }
}

abstract class SearchEvent with EquatableMixin {
  const SearchEvent();

  @override
  List<Object> get props => [];
}

class StartSearchEvent extends SearchEvent {
  final int count;
  final double delay;
  final InAppWebViewController controller;

  const StartSearchEvent({required this.count, required this.delay, required this.controller});

  @override
  List<Object> get props => [count, delay, controller];
}

class CancelSearchEvent extends SearchEvent {}

abstract class SearchState with EquatableMixin {
  const SearchState();

  @override
  List<Object> get props => [];
}

class SearchInitial extends SearchState {}

class SearchInProgress extends SearchState {
  final bool isCancelled;
  final int currentCount;
  final int totalCount;
  const SearchInProgress({this.isCancelled = false, this.currentCount = 0, this.totalCount = 0});

  @override
  List<Object> get props => [isCancelled, currentCount];
}

class SearchCancelled extends SearchState {}

class SearchSuccess extends SearchState {}

class SearchFailure extends SearchState {
  final String message;

  const SearchFailure(this.message);

  @override
  List<Object> get props => [message];
}